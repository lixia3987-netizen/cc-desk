import { test, expect, _electron as electron, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { desktopRoot } from './helpers/paths';
import { electronLaunchArgs } from './helpers/electron-launch';
import { closeNativeApp } from './helpers/native-app-cleanup';
// @ts-expect-error Test-only ESM fixture has no declarations.
import { anthropicEvents, anthropicSse } from '../../../packages/agent-node/tests/fixtures/anthropic-server.mjs';

const secret = 'native-capability-ui-artificial-main-key';
const privateThinking = 'native-capability-private-unsigned-thinking';
const privateRedacted = 'native-capability-private-redacted-data';
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdesk-capability-ui-')), data = path.join(directory, 'data'), project = path.join(directory, 'project');
  await fs.mkdir(data); await fs.mkdir(project);
  const projectId = randomUUID(), now = new Date().toISOString();
  await fs.writeFile(path.join(data, 'workspace.json'), JSON.stringify({ version: 3,
    projects: [{ id: projectId, name: '模型能力本地测试', path: project, createdAt: now }], sessions: [], settings: {
      claudePath: path.join(directory, 'missing-claude'), shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000,
      engineDefaults: { native: { schemaVersion: 1, options: { maxInputTokens: 24000, maxOutputTokens: 128 } },
        claude: { schemaVersion: 1, options: { model: 'existing-cli-model', effort: 'high' } } },
    } }));
  const requests: Array<{ method?: string; path: string; authorization?: string; body?: { max_tokens: number } }> = [];
  let cancelled = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '', 'http://localhost'), record: typeof requests[number] = { method: request.method, path: url.pathname, authorization: request.headers.authorization };
    requests.push(record);
    if (request.method === 'POST' && url.pathname === '/v1/messages') {
      const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      record.body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      response.end(anthropicEvents([{ type: 'thinking', thinking: privateThinking }, { type: 'redacted_thinking', data: privateRedacted }, { type: 'text', text: '本地模型能力验证完成。' }]).map(anthropicSse).join('')); return;
    }
    if (request.method !== 'GET' || !url.pathname.startsWith('/v1/models')) { response.writeHead(500); response.end(); return; }
    const model = decodeURIComponent(url.pathname.slice('/v1/models/'.length));
    if (model === 'fixture-missing') { response.writeHead(404); response.end(secret + 'private provider error'); return; }
    if (model === 'fixture-timeout') {
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.flushHeaders(); response.on('close', () => { cancelled++; }); return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    if (url.pathname === '/v1/models') response.end(JSON.stringify({ data: [
      { id: 'fixture-partial', context_window: 64000, max_input_tokens: 40000, max_output_tokens: 8192 },
      { id: 'fixture-unknown', context_window: null, max_input_tokens: 0 },
    ], has_more: false, last_id: 'fixture-unknown' }));
    else response.end(JSON.stringify(model === 'fixture-partial' ? { id: model, context_window: 48000, max_output_tokens: 1024 } : { id: model, context_window: null, max_input_tokens: 0 }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { data, projectId, baseURL, requests, cancelled: () => cancelled,
    launch: () => electron.launch({ args: electronLaunchArgs(), cwd: desktopRoot, env: { ...process.env,
      WORKBENCH_TEST_MODE: '1', WORKBENCH_DATA_DIR: data, MODEL_CAPABILITY_UI_KEY: secret,
    } }),
    async dispose() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  };
}
async function ready(page: Page) { await expect(page.locator('main.workspace')).toBeVisible(); }
async function seed(page: Page, baseURL: string, model: string) {
  return page.evaluate(({ baseURL, model }) => window.desktop.nativeConnections.upsert({ name: model, protocol: 'anthropic', authHeader: 'authorization',
    baseURL, model, allowLoopbackHttp: true, enabled: true, auth: { mode: 'env', variable: 'MODEL_CAPABILITY_UI_KEY' },
  }), { baseURL, model });
}
async function openModels(page: Page) {
  await page.getByRole('button', { name: '设置与连接', exact: true }).click();
  await page.getByRole('tab', { name: '模型配置', exact: true }).click();
  return page.getByRole('region', { name: 'Native 模型连接', exact: true });
}
async function assertPrivate(page: Page, data: string) {
  const exposed = await page.evaluate(async () => ({ markup: document.body.outerHTML, connections: await window.desktop.nativeConnections.list(), snapshot: await window.desktop.snapshot() }));
  for (const value of [secret, privateThinking, privateRedacted, 'private provider error']) expect(JSON.stringify(exposed)).not.toContain(value);
  expect(await fs.readFile(path.join(data, 'native', 'connections.json'), 'utf8')).not.toContain(secret);
}

test('automatic partial metadata displays field sources and survives a real thinking response and restart without raising user budgets', async ({}, testInfo) => {
  const f = await fixture(); let app = await f.launch();
  try {
    let page = await app.firstWindow(); await ready(page); const configured = await seed(page, f.baseURL, 'fixture-partial');
    const region = await openModels(page), card = region.locator('.model-connection-card'), info = card.getByRole('group', { name: '模型窗口信息', exact: true });
    await expect(info).toContainText(/模型窗口：48[,.]?000 tokens（服务端）/);
    await expect(info).toContainText(/输入上限：40[,.]?000 tokens（模型目录）/);
    await expect(info).toContainText(/输出上限：1[,.]?024 tokens（服务端）/);
    const capabilityText = await info.textContent() ?? '';
    expect(f.requests.filter(item => item.method === 'GET')).toHaveLength(2); expect(f.requests.filter(item => item.method === 'POST')).toHaveLength(0);
    await expect(card.getByLabel('可用模型', { exact: true })).toHaveCount(0);
    await region.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(info).toHaveText(capabilityText);
    expect(f.requests.filter(item => item.method === 'GET')).toHaveLength(2);
    await page.screenshot({ path: testInfo.outputPath('model-capabilities-card.png') });
    await page.getByRole('button', { name: '取消', exact: true }).click();
    const session = await page.evaluate(async ({ projectId, connectionId }) => {
      const session = await window.desktop.createSession({ projectId, title: '能力与 thinking 本地测试', kind: 'agent', providerId: 'native', mode: 'structured', isolated: false,
        engineConfig: { schemaVersion: 1, options: { connectionId, maxInputTokens: 24000, maxOutputTokens: 128 } } });
      await window.desktop.setSelection(session.id); return session;
    }, { projectId: f.projectId, connectionId: configured.id });
    const result = await page.evaluate(({ id, requestId }) => window.desktop.sendChat(id, 'Give a short local response.', [], requestId), { id: session.id, requestId: randomUUID() });
    expect(result.success).toBe(true); expect(f.requests.filter(item => item.method === 'POST')).toHaveLength(1);
    expect(f.requests.find(item => item.method === 'POST')!.body!.max_tokens).toBe(128);
    const meter = page.locator('details.context-meter'); await expect(meter).toHaveCount(1); await meter.locator('summary').click();
    await expect(meter.getByRole('group', { name: '模型窗口信息', exact: true })).toHaveText(capabilityText);
    const snapshot = await page.evaluate(async id => ({ state: (await window.desktop.snapshot()).state, chat: await window.desktop.chatSnapshot(id) }), session.id);
    expect(snapshot.chat.context?.budget?.maxInputTokens).toBe(24000);
    expect(snapshot.state.sessions.find(item => item.id === session.id)!.engineConfig.options).toMatchObject({ maxInputTokens: 24000, maxOutputTokens: 128 });
    expect(snapshot.state.settings.engineDefaults.native.options).toMatchObject({ maxInputTokens: 24000, maxOutputTokens: 128 });
    expect(snapshot.state.settings.engineDefaults.claude.options).toMatchObject({ model: 'existing-cli-model', effort: 'high' });
    await assertPrivate(page, f.data); await page.screenshot({ path: testInfo.outputPath('model-capabilities-context.png') });
    await closeNativeApp(app); app = await f.launch(); page = await app.firstWindow(); await ready(page);
    const restored = await page.evaluate(id => window.desktop.chatSnapshot(id), session.id);
    expect(restored.context?.modelCapabilities).toEqual(snapshot.chat.context?.modelCapabilities);
    expect(restored.context?.budget?.maxInputTokens).toBe(24000); expect(f.requests.filter(item => item.method === 'POST')).toHaveLength(1);
    await assertPrivate(page, f.data);
  } finally { await closeNativeApp(app); await f.dispose(); }
});

test('unknown, missing and timed-out capability metadata stays unknown using only bounded GET requests', async () => {
  const f = await fixture(), app = await f.launch();
  try {
    const page = await app.firstWindow(); await ready(page);
    const connections = [];
    for (const model of ['fixture-unknown', 'fixture-missing', 'fixture-timeout']) connections.push(await seed(page, f.baseURL, model));
    const region = await openModels(page); await expect(region.locator('.model-connection-card')).toHaveCount(3);
    const results = await page.evaluate(values => Promise.all(values.map(item => window.desktop.nativeConnections.modelCapabilities({ id: item.id, revision: item.revision }))), connections);
    expect(results.map(result => result.code)).toEqual(['ok', 'ok', 'timeout']);
    for (const result of results) expect(result.capabilities).toEqual({});
    for (const model of ['fixture-unknown', 'fixture-missing', 'fixture-timeout']) {
      const card = region.locator('.model-connection-card').filter({ has: page.getByText(model, { exact: true }) });
      await expect(card.getByRole('group', { name: '模型窗口信息', exact: true })).toContainText('窗口信息未知，沿用用户预算');
      await expect(card.getByLabel('可用模型', { exact: true })).toHaveCount(0);
    }
    await expect.poll(f.cancelled).toBe(1); expect(f.requests).toHaveLength(5);
    for (const request of f.requests) { expect(request.method).toBe('GET'); expect(request.authorization).toBe(`Bearer ${secret}`); }
    const count = f.requests.length;
    await page.evaluate(values => Promise.all(values.map(item => window.desktop.nativeConnections.modelCapabilities({ id: item.id, revision: item.revision }))), connections);
    expect(f.requests).toHaveLength(count); await assertPrivate(page, f.data);
  } finally { await closeNativeApp(app); await f.dispose(); }
});
