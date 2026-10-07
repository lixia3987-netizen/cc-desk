import { test, expect, _electron as electron, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { desktopRoot } from './helpers/paths';
import { electronLaunchArgs } from './helpers/electron-launch';
// @ts-expect-error Shared test-only ESM fixture has no declarations.
import { listenOnFetchLoopback } from '../../../packages/agent-node/tests/fixtures/fetch-loopback.mjs';

const secret = 'native-model-list-ui-main-only-token';
const privateBody = 'native-model-list-provider-error-DO-NOT-DISPLAY';
type Mode = 'complete' | 'unauthorized' | 'empty' | 'stall';

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdesk-native-model-list-ui-'));
  const data = path.join(directory, 'data'); await fs.mkdir(data);
  await fs.writeFile(path.join(data, 'workspace.json'), JSON.stringify({ version: 3, projects: [], sessions: [], settings: {
    claudePath: path.join(directory, 'missing-claude'), shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000,
    engineDefaults: { claude: { schemaVersion: 1, options: { model: 'existing-claude-model', effort: 'high', permissionMode: 'plan' } } },
  } }));
  let mode: Mode = 'complete', cancelled = 0;
  const requests: Array<{ method?: string; url?: string; authorization?: string; apiKey?: string | string[]; anthropicVersion?: string | string[] }> = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization,
      apiKey: request.headers['x-api-key'], anthropicVersion: request.headers['anthropic-version'] });
    const url = new URL(request.url ?? '', 'http://localhost');
    if (request.method === 'GET' && url.pathname.startsWith('/v1/models/')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: decodeURIComponent(url.pathname.slice('/v1/models/'.length)), context_window: 64000, max_input_tokens: 64000, max_output_tokens: 4096 })); return;
    }
    if (request.method !== 'GET' || url.pathname !== '/v1/models') { response.writeHead(404); response.end(); return; }
    if (mode === 'unauthorized') { response.writeHead(401); response.end(secret + privateBody); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    if (mode === 'stall') {
      response.on('close', () => { cancelled++; }); response.flushHeaders(); return;
    }
    response.end(JSON.stringify({ data: mode === 'empty' ? [] : [
      { id: 'fixture-alpha', display_name: 'Fixture Alpha', type: 'model' },
      { id: 'fixture-beta', display_name: 'Fixture Beta', type: 'model' },
    ], has_more: false, first_id: mode === 'empty' ? null : 'fixture-alpha', last_id: mode === 'empty' ? null : 'fixture-beta' }));
  });
  await listenOnFetchLoopback(server);
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const launch = () => electron.launch({ args: electronLaunchArgs(), cwd: desktopRoot, env: {
    ...process.env, WORKBENCH_TEST_MODE: '1', WORKBENCH_DATA_DIR: data, MODEL_LIST_UI_TOKEN: secret,
  } });
  return { data, baseURL, requests, launch, setMode: (next: Mode) => { mode = next; }, cancelled: () => cancelled, dispose: async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } };
}

async function seed(page: Page, baseURL: string) {
  await expect(page.getByRole('button', { name: '设置与连接', exact: true })).toBeVisible();
  return page.evaluate(baseURL => window.desktop.nativeConnections.upsert({ name: '模型列表连接', protocol: 'anthropic', authHeader: 'authorization',
    baseURL, model: 'fixture-current-not-listed', allowLoopbackHttp: true, enabled: true, auth: { mode: 'env', variable: 'MODEL_LIST_UI_TOKEN' },
    pricing: { model: 'fixture-current-not-listed', inputUSDPerMillion: 2, outputUSDPerMillion: 8 },
  }), baseURL);
}

async function openModels(page: Page) {
  await page.getByRole('button', { name: '设置与连接', exact: true }).click();
  await page.getByRole('tab', { name: '模型与上下文', exact: true }).click();
  const region = page.getByRole('region', { name: 'Native 模型连接', exact: true });
  await expect(region.locator('.model-connection-card')).toHaveCount(1);
  await expect(region.getByLabel('模型窗口信息', { exact: true })).toContainText(/64[,.]?000/);
  return { region, card: region.locator('.model-connection-card') };
}

async function savedConnection(page: Page) {
  return (await page.evaluate(() => window.desktop.nativeConnections.list())).connections[0];
}

async function assertPrivate(page: Page, data: string) {
  const metadata = await page.evaluate(async () => ({ markup: document.body.outerHTML,
    connections: await window.desktop.nativeConnections.list(), snapshot: await window.desktop.snapshot(),
  }));
  expect(JSON.stringify(metadata)).not.toContain(secret);
  expect(JSON.stringify(metadata)).not.toContain(privateBody);
  const saved = await fs.readFile(path.join(data, 'native', 'connections.json'), 'utf8');
  expect(saved).not.toContain(secret); expect(saved).not.toContain(privateBody);
}

function assertRequests(requests: Awaited<ReturnType<typeof fixture>>['requests']) {
  for (const request of requests) {
    const url = new URL(request.url ?? '', 'http://localhost');
    expect(request.method).toBe('GET'); expect(url.pathname === '/v1/models' || url.pathname.startsWith('/v1/models/')).toBe(true);
    expect([...url.searchParams.entries()].every(([key, value]) => url.pathname === '/v1/models' && key === 'limit' && value === '100')).toBe(true);
    expect(request.authorization).toBe(`Bearer ${secret}`); expect(request.apiKey).toBeUndefined();
    expect(request.anthropicVersion).toBe('2023-06-01');
  }
}

const listRequests = (requests: Awaited<ReturnType<typeof fixture>>['requests']) => requests.filter(request => new URL(request.url ?? '', 'http://localhost').pathname === '/v1/models');

test('available model choices never replace an absent current model until an explicit switch, which preserves metadata across restart', async ({}, testInfo) => {
  const f = await fixture(); let app = await f.launch();
  try {
    let page = await app.firstWindow();
    const initial = await seed(page, f.baseURL);
    let { card } = await openModels(page);
    expect(listRequests(f.requests)).toHaveLength(0);
    await expect(card.getByLabel('可用模型', { exact: true })).toHaveCount(0);
    await card.getByRole('button', { name: '读取可用模型', exact: true }).click();
    const choices = card.getByLabel('可用模型', { exact: true });
    await expect(choices).toBeVisible();
    for (const id of ['fixture-alpha', 'fixture-beta']) await expect(choices.locator(`option[value="${id}"]`)).toHaveCount(1);
    expect(await savedConnection(page)).toEqual(initial);
    await expect(card).toContainText('fixture-current-not-listed');
    expect(listRequests(f.requests)).toHaveLength(1);
    await choices.selectOption('fixture-beta');
    expect(await savedConnection(page)).toEqual(initial);
    await choices.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('available-models-listed.png') });
    await card.getByRole('button', { name: '切换模型', exact: true }).click();
    await expect.poll(async () => (await savedConnection(page)).model).toBe('fixture-beta');
    const changed = await savedConnection(page);
    expect(changed.revision).toBeGreaterThan(initial.revision);
    expect(changed).toMatchObject({ id: initial.id, name: initial.name, baseURL: f.baseURL, protocol: 'anthropic', authHeader: 'authorization',
      auth: { mode: 'env', variable: 'MODEL_LIST_UI_TOKEN' }, allowLoopbackHttp: true, enabled: true, ready: true });
    expect(changed.pricing).toEqual(initial.pricing);
    expect(listRequests(f.requests)).toHaveLength(1);
    expect((await page.evaluate(() => window.desktop.snapshot())).state.settings.engineDefaults.claude.options).toMatchObject({ model: 'existing-claude-model', effort: 'high' });
    await assertPrivate(page, f.data); assertRequests(f.requests);
    await page.screenshot({ path: testInfo.outputPath('available-models-switched.png') });

    await app.close(); app = await f.launch(); page = await app.firstWindow(); ({ card } = await openModels(page));
    await expect(card).toContainText('fixture-beta');
    expect(await savedConnection(page)).toEqual(changed);
    expect(listRequests(f.requests), 'automatic window metadata never populates available model choices').toHaveLength(1);
    await expect(card.getByLabel('可用模型', { exact: true })).toHaveCount(0);
    await assertPrivate(page, f.data);
  } finally { await app.close(); await f.dispose(); }
});

test('model-list errors, empty replies and cancellation preserve the current connection and manual model entry remains available', async () => {
  const f = await fixture(), app = await f.launch();
  try {
    const page = await app.firstWindow(), initial = await seed(page, f.baseURL), { region, card } = await openModels(page);
    const read = card.getByRole('button', { name: '读取可用模型', exact: true });
    f.setMode('unauthorized'); await read.click();
    await expect(card.getByRole('status')).toContainText(/认证|401/);
    expect(await savedConnection(page)).toEqual(initial);
    await assertPrivate(page, f.data);
    f.setMode('empty'); await read.click();
    await expect(card.getByRole('status')).toContainText(/空|未返回|没有|未发现|0\s*(个|项|款)/);
    expect(await savedConnection(page)).toEqual(initial);
    await expect(card.getByLabel('可用模型', { exact: true }).locator('option[value="fixture-beta"]')).toHaveCount(0);

    f.setMode('stall'); await read.click();
    await expect.poll(() => listRequests(f.requests).length).toBe(3);
    await expect(card.getByRole('button', { name: '编辑', exact: true })).toBeDisabled();
    await card.getByRole('button', { name: /取消.*读取|取消.*模型/ }).click();
    await expect(card.getByRole('status')).toContainText(/取消/);
    await expect.poll(f.cancelled).toBe(1);
    await expect(read).toBeEnabled(); expect(await savedConnection(page)).toEqual(initial);
    f.setMode('complete'); await read.click();
    await expect(card.getByLabel('可用模型', { exact: true })).toBeVisible();
    expect(await savedConnection(page)).toEqual(initial);
    await card.getByLabel('可用模型', { exact: true }).selectOption('fixture-beta');
    const switchModel = card.getByRole('button', { name: '切换模型', exact: true });
    await expect(switchModel).toBeEnabled();
    await card.getByRole('button', { name: '编辑', exact: true }).click();
    await region.getByLabel('Native 默认模型', { exact: true }).fill('fixture-manually-entered');
    await expect(read).toBeDisabled(); await expect(switchModel).toBeDisabled();
    expect(await savedConnection(page)).toEqual(initial);
    await region.getByRole('button', { name: '保存模型连接', exact: true }).click();
    await expect.poll(async () => (await savedConnection(page)).model).toBe('fixture-manually-entered');
    await expect(card.getByLabel('可用模型', { exact: true })).toHaveCount(0);
    expect(await savedConnection(page)).toMatchObject({ protocol: 'anthropic', authHeader: 'authorization', baseURL: f.baseURL,
      auth: { mode: 'env', variable: 'MODEL_LIST_UI_TOKEN' }, ready: true });
    expect(listRequests(f.requests)).toHaveLength(4); assertRequests(f.requests); await assertPrivate(page, f.data);
  } finally { await app.close(); await f.dispose(); }
});
