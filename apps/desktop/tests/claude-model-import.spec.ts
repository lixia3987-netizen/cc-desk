import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { desktopRoot } from './helpers/paths';
import { electronLaunchArgs } from './helpers/electron-launch';

const claudeDefaults = { schemaVersion: 1, options: { model: 'claude-original-default', effort: 'high', permissionMode: 'plan' } };

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdesk-claude-model-import-ui-'));
  const data = path.join(directory, 'data'), configDirectory = path.join(directory, 'claude-config');
  await fs.mkdir(data); await fs.mkdir(configDirectory);
  await fs.writeFile(path.join(data, 'workspace.json'), JSON.stringify({ version: 3, projects: [], sessions: [], settings: {
    claudePath: path.join(directory, 'missing-claude'), shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000, engineDefaults: { claude: claudeDefaults },
  } }));
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.writeHead(503); response.end(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/gateway`;
  const launch = () => electron.launch({ args: electronLaunchArgs(), cwd: desktopRoot, env: {
    ...process.env, WORKBENCH_TEST_MODE: '1', WORKBENCH_DATA_DIR: data, CLAUDE_CONFIG_DIR: configDirectory,
  } });
  return { directory, data, configDirectory, baseURL, launch, requests: () => requests, dispose: async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } };
}

async function openModels(page: Page) {
  await page.getByRole('button', { name: '设置与连接', exact: true }).click();
  await page.getByRole('tab', { name: '模型配置', exact: true }).click();
  return page.getByRole('region', { name: 'Native 模型连接', exact: true });
}

async function assertPrivate(page: Page, data: string, secrets: string[]) {
  const visible = await page.evaluate(async () => ({
    document: document.body.outerHTML,
    inputValues: [...document.querySelectorAll('input')].map(input => input.value),
    connections: await window.desktop.nativeConnections.list(),
    workspace: await window.desktop.snapshot(),
  }));
  const serialized = JSON.stringify(visible);
  const files = [path.join(data, 'workspace.json'), ...(
    await fs.readdir(path.join(data, 'native'), { withFileTypes: true }).catch(() => [])
  ).filter(item => item.isFile()).map(item => path.join(data, 'native', item.name))];
  for (const secret of secrets) {
    expect(serialized).not.toContain(secret);
    for (const file of files) expect(await fs.readFile(file, 'utf8')).not.toContain(secret);
  }
}

async function chooseConfig(app: ElectronApplication, selected: string | null) {
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = (async () => ({ canceled: selected === null, filePaths: selected === null ? [] : [selected] })) as typeof dialog.showOpenDialog;
  }, selected);
}

test('Claude model import previews multiple default models privately, cancels without changes and imports an independent memory connection', async ({}, testInfo) => {
  const f = await fixture();
  const secret = 'claude-import-ui-auth-token-DO-NOT-EXPOSE';
  const unusedKey = 'claude-import-ui-unused-api-key-DO-NOT-EXPOSE';
  const sourcePath = path.join(f.configDirectory, 'settings.json');
  const source = JSON.stringify({ model: 'sonnet', env: {
    ANTHROPIC_BASE_URL: f.baseURL, ANTHROPIC_AUTH_TOKEN: secret, ANTHROPIC_API_KEY: unusedKey,
    ANTHROPIC_MODEL: 'fixture-primary', ANTHROPIC_DEFAULT_SONNET_MODEL: 'fixture-sonnet', ANTHROPIC_DEFAULT_OPUS_MODEL: 'fixture-opus',
  } });
  await fs.writeFile(sourcePath, source);
  let app = await f.launch();
  try {
    let page = await app.firstWindow(), region = await openModels(page);
    const initialSettings = (await page.evaluate(() => window.desktop.snapshot())).state.settings;
    expect(initialSettings.engineDefaults.claude).toEqual(claudeDefaults);
    const modelPage = page.getByRole('tabpanel', { name: '模型配置', exact: true });
    await expect(modelPage.getByRole('heading', { name: '自研 Agent 模型连接', exact: true })).toBeVisible();
    await expect(modelPage.getByRole('heading', { name: /Claude.*默认.*模型/ })).toHaveCount(0);
    await expect(modelPage.getByLabel('默认模型', { exact: true })).toHaveCount(0);
    await expect(modelPage.getByLabel('默认推理强度', { exact: true })).toHaveCount(0);
    await expect(modelPage.locator('details').filter({ hasText: '新会话默认模型' })).toHaveJSProperty('open', false);
    await expect(region.locator('details').filter({ hasText: '连接与测试说明' })).toHaveJSProperty('open', false);
    await page.getByRole('tab', { name: '终端配置', exact: true }).click();
    await expect(page.getByRole('button', { name: '从 Claude 默认配置导入', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '选择 Claude 配置文件', exact: true })).toHaveCount(0);
    await page.getByRole('tab', { name: '模型配置', exact: true }).click();
    await region.getByRole('button', { name: '从 Claude 默认配置导入', exact: true }).click();
    const preview = page.getByRole('region', { name: 'Claude 模型导入预览', exact: true });
    await expect(preview).toBeVisible();
    await expect(preview.getByRole('heading', { name: '导入为自研 Agent 模型', exact: true })).toBeVisible();
    await expect(preview).toContainText('Anthropic Messages');
    await expect(preview).toContainText(sourcePath);
    await expect(preview).toContainText(f.baseURL);
    await expect(preview).toContainText('凭据：已读取（内容不显示）');
    const models = preview.getByLabel('导入模型', { exact: true });
    await expect(models).toHaveValue('fixture-primary');
    for (const model of ['fixture-primary', 'fixture-sonnet', 'fixture-opus']) await expect(models.locator(`option[value="${model}"]`)).toHaveCount(1);
    await models.selectOption('fixture-opus');
    await expect(preview.getByLabel('允许导入本地回环 HTTP', { exact: true })).not.toBeChecked();
    await expect(preview.getByRole('button', { name: '确认导入模型连接', exact: true })).toBeDisabled();
    expect(f.requests()).toBe(0);
    expect((await page.evaluate(() => window.desktop.nativeConnections.list())).connections).toEqual([]);
    await expect(fs.stat(path.join(f.data, 'native', 'connections.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const previewMetadata = await page.evaluate(() => window.desktop.claudeModelImport.preview({ source: 'default' }));
    expect(previewMetadata?.credential).toEqual({ configured: true, source: 'ANTHROPIC_AUTH_TOKEN' });
    expect(JSON.stringify(previewMetadata)).not.toContain(secret);
    expect(JSON.stringify(previewMetadata)).not.toContain(unusedKey);
    await assertPrivate(page, f.data, [secret, unusedKey]);
    await preview.getByRole('button', { name: '取消导入', exact: true }).click();
    await expect(preview).toHaveCount(0);
    expect((await page.evaluate(() => window.desktop.nativeConnections.list())).connections).toEqual([]);
    expect(await fs.readFile(sourcePath, 'utf8')).toBe(source);

    await region.getByRole('button', { name: '从 Claude 默认配置导入', exact: true }).click();
    await preview.getByLabel('导入模型', { exact: true }).selectOption('fixture-opus');
    await preview.getByLabel('导入凭据保存方式', { exact: true }).selectOption('memory');
    await preview.getByLabel('允许导入本地回环 HTTP', { exact: true }).check();
    await preview.getByRole('button', { name: '确认导入模型连接', exact: true }).click();
    await expect(preview).toHaveCount(0);
    await expect(region.locator('.connection-box')).toContainText('fixture-opus');
    await expect(region.locator('.connection-box')).toContainText('就绪');
    await expect(region.getByLabel('Native 模型协议', { exact: true })).toHaveCount(0);
    await expect(region.getByLabel('Native 新的 API Key', { exact: true })).toHaveCount(0);
    const imported = (await page.evaluate(() => window.desktop.nativeConnections.list())).connections;
    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({ protocol: 'anthropic', authHeader: 'authorization', model: 'fixture-opus', baseURL: f.baseURL,
      allowLoopbackHttp: true, auth: { mode: 'memory' }, enabled: true, ready: true, credentialConfigured: true });
    const state = (await page.evaluate(() => window.desktop.snapshot())).state;
    expect(state.settings).toEqual(initialSettings);
    expect(state.settings.engineDefaults.claude).toEqual(claudeDefaults);
    expect(f.requests()).toBe(0);
    expect(await fs.readFile(sourcePath, 'utf8')).toBe(source);
    await assertPrivate(page, f.data, [secret, unusedKey]);
    await page.screenshot({ path: testInfo.outputPath('claude-imported-model.png') });

    await app.close(); app = await f.launch(); page = await app.firstWindow(); region = await openModels(page);
    await expect(region.locator('.connection-box')).toContainText('未就绪');
    const restarted = (await page.evaluate(() => window.desktop.nativeConnections.list())).connections;
    expect(restarted[0]).toMatchObject({ id: imported[0].id, model: 'fixture-opus', protocol: 'anthropic', authHeader: 'authorization', ready: false, credentialConfigured: false });
    expect(f.requests()).toBe(0);
    await assertPrivate(page, f.data, [secret, unusedKey]);
  } finally { await app.close(); await f.dispose(); }
});

test('Claude model file selection imports API-key authentication and preserves its header while editing or toggling the connection', async () => {
  const f = await fixture();
  const sourcePath = path.join(f.directory, 'chosen Claude settings.json');
  const secret = 'claude-import-ui-file-api-key-DO-NOT-EXPOSE';
  const source = JSON.stringify({ model: 'fixture-file-model', env: { ANTHROPIC_BASE_URL: f.baseURL, ANTHROPIC_API_KEY: secret } });
  await fs.writeFile(sourcePath, source);
  const app = await f.launch();
  try {
    const page = await app.firstWindow(), region = await openModels(page);
    await chooseConfig(app, null);
    await region.getByRole('button', { name: '选择 Claude 配置文件', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Claude 模型导入预览', exact: true })).toHaveCount(0);
    expect((await page.evaluate(() => window.desktop.nativeConnections.list())).connections).toEqual([]);
    await chooseConfig(app, sourcePath);
    await region.getByRole('button', { name: '选择 Claude 配置文件', exact: true }).click();
    const preview = page.getByRole('region', { name: 'Claude 模型导入预览', exact: true });
    await expect(preview.getByRole('heading', { name: '导入为自研 Agent 模型', exact: true })).toBeVisible();
    await expect(preview).toContainText(sourcePath);
    await expect(preview.getByLabel('导入模型', { exact: true })).toHaveValue('fixture-file-model');
    await preview.getByLabel('导入凭据保存方式', { exact: true }).selectOption('memory');
    await preview.getByLabel('允许导入本地回环 HTTP', { exact: true }).check();
    await assertPrivate(page, f.data, [secret]);
    expect(f.requests()).toBe(0);
    await preview.getByRole('button', { name: '确认导入模型连接', exact: true }).click();
    await expect(region.locator('.connection-box')).toHaveCount(1);
    expect((await page.evaluate(() => window.desktop.nativeConnections.list())).connections[0]).toMatchObject({ protocol: 'anthropic', authHeader: 'x-api-key', model: 'fixture-file-model', ready: true });
    await expect(region.getByLabel('Native 模型协议', { exact: true })).toHaveCount(0);
    await region.getByRole('button', { name: '编辑', exact: true }).click();
    await expect(region.getByLabel('Native 模型协议', { exact: true })).toHaveValue('anthropic');
    await expect(region.locator('details').filter({ hasText: '高级设置（价格与本地代理）' })).toHaveJSProperty('open', false);
    await region.getByLabel('Native 默认模型', { exact: true }).fill('fixture-edited-model');
    await region.getByRole('button', { name: '保存模型连接', exact: true }).click();
    await expect(region.locator('.connection-box')).toContainText('fixture-edited-model');
    expect((await page.evaluate(() => window.desktop.nativeConnections.list())).connections[0]).toMatchObject({ protocol: 'anthropic', authHeader: 'x-api-key', model: 'fixture-edited-model', ready: true });
    await region.getByRole('button', { name: '禁用', exact: true }).click();
    await expect(region.locator('.connection-box')).toContainText('已禁用');
    await region.getByRole('button', { name: '启用', exact: true }).click();
    await expect.poll(() => page.evaluate(async () => (await window.desktop.nativeConnections.list()).connections[0].ready)).toBe(true);
    expect((await page.evaluate(() => window.desktop.nativeConnections.list())).connections[0].authHeader).toBe('x-api-key');
    expect(f.requests()).toBe(0);
    expect(await fs.readFile(sourcePath, 'utf8')).toBe(source);
    await assertPrivate(page, f.data, [secret]);
  } finally { await app.close(); await f.dispose(); }
});

test('Claude model import consumes a failed preview and allows rereading configuration after displaying the error', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.configDirectory, 'settings.json'), JSON.stringify({ model: 'fixture-retry-model', env: {
    ANTHROPIC_BASE_URL: f.baseURL, ANTHROPIC_API_KEY: 'claude-import-error-fixture-key',
  } }));
  const app = await f.launch();
  try {
    const page = await app.firstWindow(), region = await openModels(page);
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('claude:model-import');
      ipcMain.handle('claude:model-import', async () => { throw new Error('导入预览已过期，请重新读取 Claude 配置。'); });
    });
    await region.getByRole('button', { name: '从 Claude 默认配置导入', exact: true }).click();
    const preview = page.getByRole('region', { name: 'Claude 模型导入预览', exact: true });
    await expect(preview.getByLabel('导入模型', { exact: true })).toHaveValue('fixture-retry-model');
    await preview.getByLabel('导入凭据保存方式', { exact: true }).selectOption('memory');
    await preview.getByLabel('允许导入本地回环 HTTP', { exact: true }).check();
    await preview.getByRole('button', { name: '确认导入模型连接', exact: true }).click();
    await expect(region.getByRole('alert')).toContainText('导入预览已过期，请重新读取 Claude 配置。');
    await expect(preview).toHaveCount(0);
    expect((await page.evaluate(() => window.desktop.nativeConnections.list())).connections).toEqual([]);
    await region.getByRole('button', { name: '从 Claude 默认配置导入', exact: true }).click();
    await expect(preview.getByLabel('导入模型', { exact: true })).toHaveValue('fixture-retry-model');
    await expect(region.getByRole('alert')).toHaveCount(0);
    await expect(preview.getByLabel('允许导入本地回环 HTTP', { exact: true })).not.toBeChecked();
    expect(f.requests()).toBe(0);
  } finally { await app.close(); await f.dispose(); }
});

test('Claude import opens the editor only when a converted self-developed Agent connection still needs credentials', async () => {
  const f = await fixture();
  const sourcePath = path.join(f.configDirectory, 'settings.json');
  const source = JSON.stringify({ model: 'fixture-needs-credential', env: { ANTHROPIC_BASE_URL: f.baseURL } });
  await fs.writeFile(sourcePath, source);
  const app = await f.launch();
  try {
    const page = await app.firstWindow(), region = await openModels(page);
    const initialSettings = (await page.evaluate(() => window.desktop.snapshot())).state.settings;
    await region.getByRole('button', { name: '从 Claude 默认配置导入', exact: true }).click();
    const preview = page.getByRole('region', { name: 'Claude 模型导入预览', exact: true });
    await expect(preview).toContainText('未读取，导入后需单独设置');
    await expect(preview.getByLabel('导入凭据保存方式', { exact: true })).toHaveCount(0);
    await preview.getByLabel('允许导入本地回环 HTTP', { exact: true }).check();
    await preview.getByRole('button', { name: '确认导入模型连接', exact: true }).click();
    await expect(preview).toHaveCount(0);
    await expect(region.getByLabel('Native 模型协议', { exact: true })).toHaveValue('anthropic');
    await expect(region.getByLabel('Native 默认模型', { exact: true })).toHaveValue('fixture-needs-credential');
    await expect(region.getByLabel('Native 新的 API Key', { exact: true })).toBeVisible();
    await expect(region.locator('details').filter({ hasText: '高级设置（价格与本地代理）' })).toHaveJSProperty('open', false);
    expect((await page.evaluate(() => window.desktop.nativeConnections.list())).connections[0]).toMatchObject({ protocol: 'anthropic', ready: false, credentialConfigured: false });
    const secret = 'claude-import-completed-after-missing-key';
    await region.getByLabel('Native 新的 API Key', { exact: true }).fill(secret);
    await region.getByRole('button', { name: '设置凭据并清空输入', exact: true }).click();
    await expect(region.getByLabel('Native 新的 API Key', { exact: true })).toHaveValue('');
    await expect.poll(() => page.evaluate(async () => (await window.desktop.nativeConnections.list()).connections[0].ready)).toBe(true);
    expect((await page.evaluate(() => window.desktop.snapshot())).state.settings).toEqual(initialSettings);
    expect(await fs.readFile(sourcePath, 'utf8')).toBe(source);
    expect(f.requests()).toBe(0);
    await assertPrivate(page, f.data, [secret]);
  } finally { await app.close(); await f.dispose(); }
});
