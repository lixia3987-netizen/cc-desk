import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import type { BeginRunRequest } from '@cc-desk/agent-core';
import { desktopRoot } from './helpers/paths';
import { electronLaunchArgs } from './helpers/electron-launch';

test('native connections UI saves metadata separately, clears secret input, disables and deletes, and loses memory keys at restart', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdesk-native-connections-ui-'));
  const data = path.join(directory, 'data');
  await fs.mkdir(data);
  await fs.writeFile(path.join(data, 'workspace.json'), JSON.stringify({ version: 3, projects: [], sessions: [], settings: {
    claudePath: path.join(directory, 'missing-claude'), shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000, engineDefaults: {},
  } }));
  const launch = () => electron.launch({ args: electronLaunchArgs(), cwd: desktopRoot, env: { ...process.env, WORKBENCH_TEST_MODE: '1', WORKBENCH_DATA_DIR: data } });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await page.getByRole('button', { name: '设置与连接', exact: false }).click();
    await page.getByRole('tab', { name: '连接与终端', exact: true }).click();
    const connections = page.getByRole('region', { name: 'Native 模型连接', exact: true });
    await connections.getByRole('button', { name: '新增模型连接', exact: true }).click();
    await page.getByLabel('Native 连接名称', { exact: true }).fill('UI 内存连接');
    await page.getByLabel('Native 服务地址', { exact: true }).fill('https://model.example.test/v1');
    await page.getByLabel('Native 默认模型', { exact: true }).fill('fixture-model');
    await page.getByLabel('Native 认证方式', { exact: true }).selectOption('memory');
    await connections.getByRole('button', { name: '保存模型连接', exact: true }).click();
    await expect(connections.locator('.connection-box')).toContainText('未就绪');
    const sentinel = 'sk-native-ui-secret-sentinel-DO-NOT-PERSIST';
    await page.getByLabel('Native 新的 API Key', { exact: true }).fill(sentinel);
    await connections.getByRole('button', { name: '设置凭据并清空输入', exact: true }).click();
    await expect(page.getByLabel('Native 新的 API Key', { exact: true })).toHaveValue('');
    await expect(connections.locator('.connection-box')).toContainText('就绪');
    const metadata = await page.evaluate(async () => ({ connections: await window.desktop.nativeConnections.list(), workspace: await window.desktop.snapshot() }));
    expect(JSON.stringify(metadata)).not.toContain(sentinel);
    expect(metadata.connections.connections[0].ready).toBe(true);
    expect(await fs.readFile(path.join(data, 'native/connections.json'), 'utf8')).not.toContain(sentinel);
    await connections.getByRole('button', { name: '禁用', exact: true }).click();
    await expect(connections.locator('.connection-box')).toContainText('已禁用');
    await connections.getByRole('button', { name: '启用', exact: true }).click();
    await expect.poll(() => page.evaluate(async () => (await window.desktop.nativeConnections.list()).connections[0].ready)).toBe(true);
    await app.close(); app = await launch(); page = await app.firstWindow();
    await page.getByRole('button', { name: '设置与连接', exact: false }).click();
    await page.getByRole('tab', { name: '连接与终端', exact: true }).click();
    const restarted = page.getByRole('region', { name: 'Native 模型连接', exact: true });
    await expect(restarted.locator('.connection-box')).toContainText('UI 内存连接');
    await expect(restarted.locator('.connection-box')).toContainText('未就绪');
    await expect(restarted.locator('.connection-box')).toContainText('不会跨重启保留');
    await restarted.getByRole('button', { name: '删除', exact: true }).click();
    await expect(restarted.locator('.connection-box')).toHaveCount(0);
  } finally { await app.close(); await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('native readiness is per session, preserves saved history and Claude defaults, and hides unsupported actions', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdesk-native-readiness-ui-'));
  const data = path.join(directory, 'data'), cwd = path.join(directory, 'project');
  await fs.mkdir(data); await fs.mkdir(cwd);
  const sessionId = randomUUID(), conversationId = randomUUID(), projectId = randomUUID(), now = new Date().toISOString();
  await fs.writeFile(path.join(data, 'workspace.json'), JSON.stringify({ version: 3,
    projects: [{ id: projectId, name: 'Native 测试项目', path: cwd, createdAt: now }],
    sessions: [{ id: sessionId, projectId, title: '缺失连接的历史', kind: 'agent', cwd,
      execution: { providerId: 'native', mode: 'structured', conversationId },
      engineConfig: { schemaVersion: 1, options: { connectionId: 'missing-connection', model: '' } },
      started: true, status: 'stopped', archived: false, createdAt: now, updatedAt: now }],
    selectedSessionId: sessionId,
    settings: { claudePath: path.join(directory, 'missing-claude'), shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000, engineDefaults: {} },
  }));
  // Seed durable native context so this case isolates connection readiness from
  // the separate read-only recovery path for missing model history.
  const ledger = await NativeRunStore.open({ rootDirectory: path.join(data, 'native', 'conversations'), conversationId });
  const request: BeginRunRequest = {
    identity: { sessionId, conversationId, runId: randomUUID(), requestId: randomUUID(), workerGeneration: 1 },
    input: '保留这段历史', inputDigest: 'native-readiness-fixture', userItems: [{ role: 'user', content: '保留这段历史' }],
    protocol: { id: 'openai.responses', version: 1 }, configuration: { model: 'fixture-model' }, policyRevision: 'fixture-v1',
  };
  try {
    await ledger.beginRun(request);
    await ledger.append(request.identity, { type: 'model_response', response: {
      outputItems: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '这条 native 历史在未配置连接时仍可阅读。' }] }],
      toolCalls: [], finishReason: 'completed', usage: null,
    } });
    const context = ledger.loadContext()!;
    await ledger.checkpoint(request.identity, context);
    await ledger.append(request.identity, { type: 'run_finished', result: {
      identity: request.identity, status: 'completed', reason: 'fixture_completed', modelRequests: 1, toolCalls: 0, usage: null, context, committed: true,
    } });
  } finally { await ledger.close(); }
  const app = await electron.launch({ args: electronLaunchArgs(), cwd: desktopRoot, env: { ...process.env, WORKBENCH_TEST_MODE: '1', WORKBENCH_DATA_DIR: data } });
  try {
    const page = await app.firstWindow();
    await expect(page.locator('.chat-message.assistant')).toContainText('仍可阅读');
    await expect(page.locator('.chat-composer .engine-unavailable')).toContainText('连接不存在');
    await page.getByLabel('提示词编辑器', { exact: true }).fill('保留草稿，不发送');
    await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '添加附件', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '从此会话创建分支', exact: true })).toHaveCount(0);
    await page.getByLabel('提示词编辑器', { exact: true }).fill('/');
    await expect(page.locator('.slash-menu')).toHaveCount(0);
    const connection = await page.evaluate(async () => {
      const item = await window.desktop.nativeConnections.upsert({ name: '独立的就绪连接', protocol: 'responses', baseURL: 'https://unused.example.test/v1', model: 'fixture-model', auth: { mode: 'memory' }, allowLoopbackHttp: false, enabled: true });
      return window.desktop.nativeConnections.setCredential({ id: item.id, revision: item.revision, mode: 'memory', secret: 'sk-test-only-no-network' });
    });
    await page.getByRole('button', { name: '新建会话', exact: false }).click();
    // The transition adds an opt-in provider; the default remains Claude.
    await expect(page.getByLabel('权限模式', { exact: true })).toBeVisible();
    const descriptor = await page.evaluate(async () => (await window.desktop.snapshot()).executors.find(item => item.providerId === 'native' && item.mode === 'structured')!);
    await page.getByRole('button', { name: descriptor.displayName ?? 'native', exact: true }).click();
    await expect(page.getByLabel('权限模式', { exact: true })).toHaveCount(0);
    await page.getByLabel('会话名称', { exact: true }).fill('有可用连接的 Native');
    const connectionField = descriptor.configuration!.fields.find(field => field.key === 'connectionId')!;
    if (connectionField.type === 'select') await page.getByLabel(connectionField.label, { exact: true }).selectOption(connection.id);
    else await page.getByLabel(connectionField.label, { exact: true }).fill(connection.id);
    await page.getByRole('button', { name: '创建会话', exact: true }).click();
    await expect(page.getByRole('heading', { name: '有可用连接的 Native', exact: true })).toBeVisible();
    await expect(page.getByLabel('会话模型连接', { exact: true })).toHaveValue(connection.id);
    await expect(page.locator('.chat-composer .engine-unavailable')).toHaveCount(0);
    await page.getByLabel('提示词编辑器', { exact: true }).fill('只检查 UI 就绪状态');
    await expect(page.getByLabel('提示词编辑器', { exact: true })).toHaveValue('只检查 UI 就绪状态');
    await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeEnabled();
    await expect(page.locator('.chat-composer .engine-unavailable')).toHaveCount(0);
    await page.evaluate(async item => { const { credentialConfigured: _configured, ready: _ready, error: _error, ...metadata } = item; await window.desktop.nativeConnections.upsert({ ...metadata, enabled: false }); }, connection);
    await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeDisabled();
    await expect(page.locator('.chat-composer .engine-unavailable')).toContainText('已禁用');
    await page.locator('.session-row').filter({ hasText: '缺失连接的历史' }).click();
    await expect(page.locator('.chat-message.assistant')).toContainText('仍可阅读');
    await expect(page.locator('.chat-composer .engine-unavailable')).toContainText('连接不存在');
    const requests = await page.evaluate(async () => (await window.desktop.snapshot()).state.sessions.filter(item => item.execution.providerId === 'native'));
    expect(requests.every(item => item.status !== 'running')).toBe(true);
  } finally { await app.close(); await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
