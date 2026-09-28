import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { NativeRunStore } from '@cc-desk/agent-node/run-store';
import type { BeginRunRequest } from '@cc-desk/agent-core';
import { desktopRoot } from './helpers/paths';
import { electronLaunchArgs } from './helpers/electron-launch';

test('native MCP settings persist explicit protocol choices locally and clear write-only credentials on metadata changes, close and restart', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdesk-native-mcp-ui-'));
  const data = path.join(directory, 'data');
  await fs.mkdir(data);
  await fs.writeFile(path.join(data, 'workspace.json'), JSON.stringify({ version: 3, projects: [], sessions: [], settings: {
    claudePath: path.join(directory, 'missing-claude'), shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000, engineDefaults: {},
  } }));
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.writeHead(503); response.end(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const launch = () => electron.launch({ args: electronLaunchArgs(), cwd: desktopRoot, env: { ...process.env, WORKBENCH_TEST_MODE: '1', WORKBENCH_DATA_DIR: data } });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    const open = async () => {
      await page.getByRole('button', { name: '设置与连接', exact: false }).click();
      await page.getByRole('tab', { name: '连接与终端', exact: true }).click();
      return page.getByRole('region', { name: 'Native MCP 连接', exact: true });
    };
    let region = await open();
    await region.getByRole('button', { name: '新增 MCP 连接', exact: true }).click();
    await expect(page.getByLabel('MCP 协议版本', { exact: true })).toHaveValue('2026-07-28');
    await page.getByLabel('MCP 协议版本', { exact: true }).selectOption('2025-11-25');
    await page.getByLabel('MCP 连接名称', { exact: true }).fill('MCP 本机配置');
    await page.getByLabel('MCP 服务端点', { exact: true }).fill(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
    await page.getByLabel('MCP 允许本地回环 HTTP', { exact: true }).check();
    await page.getByLabel('MCP 认证方式', { exact: true }).selectOption('memory');
    await region.getByRole('button', { name: '保存 MCP 连接', exact: true }).click();
    await expect(region.locator('.connection-box')).toContainText('未就绪');
    await expect(region.locator('.connection-box')).toContainText('协议 2025-11-25');
    const secret = 'mcp-ui-secret-DO-NOT-PERSIST';
    await page.getByLabel('MCP 新的 Bearer 凭据', { exact: true }).fill(secret);
    await region.getByRole('button', { name: '设置 MCP 凭据并清空输入', exact: true }).click();
    await expect(page.getByLabel('MCP 新的 Bearer 凭据', { exact: true })).toHaveValue('');
    await expect(region.locator('.connection-box')).toContainText('本机配置就绪');
    const previousRevision = await page.evaluate(async () => (await window.desktop.nativeMcp.list()).connections[0].revision);
    await page.getByLabel('MCP 新的 Bearer 凭据', { exact: true }).fill('version-change-secret');
    await page.getByLabel('MCP 协议版本', { exact: true }).selectOption('2026-07-28');
    await expect(page.getByLabel('MCP 新的 Bearer 凭据', { exact: true })).toHaveValue('');
    await expect(region.getByRole('button', { name: '设置 MCP 凭据并清空输入', exact: true })).toBeDisabled();
    await region.getByRole('button', { name: '保存 MCP 连接', exact: true }).click();
    await expect(region.locator('.connection-box')).toContainText('协议 2026-07-28');
    await expect(region.locator('.connection-box')).toContainText('本机配置就绪');
    expect((await page.evaluate(async () => (await window.desktop.nativeMcp.list()).connections[0])).revision).toBe(previousRevision + 1);
    await page.getByLabel('MCP 协议版本', { exact: true }).selectOption('2025-11-25');
    await region.getByRole('button', { name: '保存 MCP 连接', exact: true }).click();
    await expect(region.locator('.connection-box')).toContainText('协议 2025-11-25');
    await page.getByLabel('MCP 新的 Bearer 凭据', { exact: true }).fill('cancelled-secret');
    await region.getByRole('button', { name: '关闭 MCP 编辑', exact: true }).click();
    await region.getByRole('button', { name: '编辑', exact: true }).click();
    await expect(page.getByLabel('MCP 新的 Bearer 凭据', { exact: true })).toHaveValue('');
    await page.getByLabel('MCP 新的 Bearer 凭据', { exact: true }).fill('auth-change-secret');
    await page.getByLabel('MCP 认证方式', { exact: true }).selectOption('none');
    await page.getByLabel('MCP 认证方式', { exact: true }).selectOption('memory');
    await expect(page.getByLabel('MCP 新的 Bearer 凭据', { exact: true })).toHaveValue('');
    await region.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(region.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
    expect(requests).toBe(0);
    const metadata = await page.evaluate(async () => ({ mcp: await window.desktop.nativeMcp.list(), workspace: await window.desktop.snapshot() }));
    expect(JSON.stringify(metadata)).not.toContain(secret);
    expect(metadata.mcp.connections[0].ready).toBe(true);
    expect(metadata.mcp.connections[0].protocolVersion).toBe('2025-11-25');
    expect(await fs.readFile(path.join(data, 'native/mcp-connections.json'), 'utf8')).not.toContain(secret);
    await app.close(); app = await launch(); page = await app.firstWindow(); region = await open();
    await expect(region.locator('.connection-box')).toContainText('MCP 本机配置');
    await expect(region.locator('.connection-box')).toContainText('未就绪');
    await expect(region.locator('.connection-box')).toContainText('协议 2025-11-25');
    await region.getByRole('button', { name: '编辑', exact: true }).click();
    await expect(page.getByLabel('MCP 协议版本', { exact: true })).toHaveValue('2025-11-25');
    await expect(page.getByLabel('MCP 新的 Bearer 凭据', { exact: true })).toHaveValue('');
    await region.getByRole('button', { name: '删除', exact: true }).click();
    await expect(region.locator('.connection-box')).toHaveCount(0);
    expect(requests).toBe(0);
  } finally {
    await app.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('native stdio settings persist literal program configuration without launching and erase HTTP credential input on transport changes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdesk-native-stdio-ui-'));
  const data = path.join(directory, 'data'), marker = path.join(directory, 'must-not-start');
  const executable = process.execPath, script = path.join(directory, 'local server.mjs');
  const secret = 'stdio-ui-main-only-environment-value';
  await fs.mkdir(data);
  await fs.writeFile(script, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'started');`);
  await fs.writeFile(path.join(data, 'workspace.json'), JSON.stringify({ version: 3, projects: [], sessions: [], settings: {
    claudePath: path.join(directory, 'missing-claude'), shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000, engineDefaults: {},
  } }));
  const launch = () => electron.launch({ args: electronLaunchArgs(), cwd: desktopRoot, env: { ...process.env, WORKBENCH_TEST_MODE: '1', WORKBENCH_DATA_DIR: data, MCP_UI_SECRET_SOURCE: secret } });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    const open = async () => {
      await page.getByRole('button', { name: '设置与连接', exact: false }).click();
      await page.getByRole('tab', { name: '连接与终端', exact: true }).click();
      return page.getByRole('region', { name: 'Native MCP 连接', exact: true });
    };
    let region = await open();
    await region.getByRole('button', { name: '新增 MCP 连接', exact: true }).click();
    await expect(page.getByLabel('MCP 传输方式', { exact: true })).toHaveValue('http');
    await page.getByLabel('MCP 连接名称', { exact: true }).fill('本地 stdio 配置');
    await page.getByLabel('MCP 服务端点', { exact: true }).fill('https://unused.example.test/mcp');
    await page.getByLabel('MCP 认证方式', { exact: true }).selectOption('memory');
    await region.getByRole('button', { name: '保存 MCP 连接', exact: true }).click();
    await expect(region.locator('.connection-box')).toHaveCount(1);
    await page.getByLabel('MCP 新的 Bearer 凭据', { exact: true }).fill('clear-on-transport-change');
    await page.getByLabel('MCP 传输方式', { exact: true }).selectOption('stdio');
    await expect(page.getByLabel('MCP 新的 Bearer 凭据', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('MCP 认证方式', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('MCP 服务端点', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('MCP 协议版本', { exact: true })).toHaveValue('2025-11-25');
    await expect(page.getByLabel('MCP 协议版本', { exact: true })).toBeDisabled();
    await expect(region).toContainText('stdio 不是沙箱');
    await page.getByLabel('MCP 传输方式', { exact: true }).selectOption('http');
    await expect(page.getByLabel('MCP 服务端点', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('MCP 协议版本', { exact: true })).toHaveValue('2026-07-28');
    await page.getByLabel('MCP 认证方式', { exact: true }).selectOption('memory');
    await expect(page.getByLabel('MCP 新的 Bearer 凭据', { exact: true })).toHaveValue('');
    await page.getByLabel('MCP 传输方式', { exact: true }).selectOption('stdio');
    await page.getByLabel('MCP 可执行程序', { exact: true }).fill(executable);
    await page.getByLabel('MCP 启动参数', { exact: true }).fill('node "local server.mjs"');
    await region.getByRole('button', { name: '保存 MCP 连接', exact: true }).click();
    await expect(region.getByRole('alert')).toContainText('启动参数须为 JSON 字符串数组');
    expect((await page.evaluate(async () => (await window.desktop.nativeMcp.list()).connections[0])).transport).toBe('http');
    const argv = [script, 'space preserved', '$(literal)', '$KEY'];
    const environment = { API_KEY: 'MCP_UI_SECRET_SOURCE' };
    await page.getByLabel('MCP 启动参数', { exact: true }).fill(JSON.stringify(argv));
    await page.getByLabel('MCP 环境变量映射', { exact: true }).fill(JSON.stringify(environment));
    await region.getByRole('button', { name: '保存 MCP 连接', exact: true }).click();
    await expect(region.locator('.connection-box')).toContainText('stdio');
    await expect(region.locator('.connection-box')).toContainText('本机配置就绪');
    await region.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(region.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
    const list = await page.evaluate(async () => window.desktop.nativeMcp.list());
    expect(list.connections[0]).toMatchObject({ transport: 'stdio', executable, argv, environment, protocolVersion: '2025-11-25', auth: { mode: 'none' } });
    expect(list.connections[0]).not.toHaveProperty('endpoint');
    expect(JSON.stringify(list)).not.toContain(secret);
    expect(await page.locator('body').textContent()).not.toContain(secret);
    expect(await fs.readFile(path.join(data, 'native/mcp-connections.json'), 'utf8')).not.toContain(secret);
    await expect(fs.access(marker)).rejects.toThrow();
    await app.close(); app = await launch(); page = await app.firstWindow(); region = await open();
    await expect(region.locator('.connection-box')).toContainText('stdio');
    await region.getByRole('button', { name: '编辑', exact: true }).click();
    await expect(page.getByLabel('MCP 传输方式', { exact: true })).toHaveValue('stdio');
    await expect(page.getByLabel('MCP 可执行程序', { exact: true })).toHaveValue(executable);
    expect(JSON.parse(await page.getByLabel('MCP 启动参数', { exact: true }).inputValue())).toEqual(argv);
    expect(JSON.parse(await page.getByLabel('MCP 环境变量映射', { exact: true }).inputValue())).toEqual(environment);
    await expect(fs.access(marker)).rejects.toThrow();
  } finally { await app.close(); await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('native MCP choices save per session, retain removable unavailable entries, and discard late metadata after session switching', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdesk-native-mcp-selection-'));
  const data = path.join(directory, 'data'), cwd = path.join(directory, 'project');
  await fs.mkdir(data); await fs.mkdir(cwd);
  const sessionIds = [randomUUID(), randomUUID()], projectId = randomUUID(), now = new Date().toISOString();
  await fs.writeFile(path.join(data, 'workspace.json'), JSON.stringify({ version: 3,
    projects: [{ id: projectId, name: 'MCP 测试项目', path: cwd, createdAt: now }],
    sessions: sessionIds.map((id, index) => ({ id, projectId, title: `MCP 会话 ${index + 1}`, kind: 'agent', cwd,
      execution: { providerId: 'native', mode: 'structured', conversationId: randomUUID() },
      engineConfig: { schemaVersion: 1, options: { mcpConnections: index === 0 ? ['missing-service'] : [] } },
      started: false, status: 'stopped', archived: false, createdAt: now, updatedAt: now })),
    selectedSessionId: sessionIds[0], settings: { claudePath: path.join(directory, 'missing-claude'), shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000, engineDefaults: {} },
  }));
  const app = await electron.launch({ args: electronLaunchArgs(), cwd: desktopRoot, env: { ...process.env, WORKBENCH_TEST_MODE: '1', WORKBENCH_DATA_DIR: data } });
  try {
    const page = await app.firstWindow();
    const connections = await page.evaluate(async ids => {
      const model = await window.desktop.nativeConnections.upsert({ name: 'MCP UI 模型引用', protocol: 'responses', baseURL: 'https://unused.example.test/v1', model: 'fixture-model', auth: { mode: 'memory' }, allowLoopbackHttp: false, enabled: true });
      await window.desktop.nativeConnections.setCredential({ id: model.id, revision: model.revision, mode: 'memory', secret: 'fixture-no-network' });
      for (const id of ids) {
        const session = (await window.desktop.snapshot()).state.sessions.find(item => item.id === id)!;
        await window.desktop.updateSession({ id, engineConfig: { ...session.engineConfig, options: { ...session.engineConfig.options, connectionId: model.id } } });
      }
      const ready = await window.desktop.nativeMcp.upsert({ name: '可选服务', endpoint: 'https://mcp-unused.example.test/mcp', protocolVersion: '2025-11-25', auth: { mode: 'none' }, allowLoopbackHttp: false, enabled: true });
      const disabled = await window.desktop.nativeMcp.upsert({ name: '禁用服务', endpoint: 'https://mcp-unused.example.test/disabled', auth: { mode: 'none' }, allowLoopbackHttp: false, enabled: false });
      return { ready, disabled };
    }, sessionIds);
    const choices = page.getByRole('region', { name: '会话 MCP 工具', exact: true });
    await expect(choices).toContainText('已选 1 / 4');
    await choices.getByRole('button', { name: '读取 MCP 连接', exact: true }).click();
    await expect(choices).toContainText('协议 2025-11-25');
    await expect(choices).toContainText('协议 2026-07-28');
    await expect(choices.getByLabel(`MCP 禁用服务 (${connections.disabled.id})`, { exact: true })).toBeDisabled();
    await choices.getByLabel('MCP missing-service (missing-service)', { exact: true }).uncheck();
    await choices.getByLabel(`MCP 可选服务 (${connections.ready.id})`, { exact: true }).check();
    await page.locator('form.session-config').getByRole('button', { name: '保存配置', exact: true }).click();
    await expect.poll(() => page.evaluate(async id => (await window.desktop.snapshot()).state.sessions.find(item => item.id === id)?.engineConfig.options.mcpConnections, sessionIds[0])).toEqual([connections.ready.id]);
    await page.locator('.session-row').filter({ hasText: 'MCP 会话 2' }).click();
    await expect(choices).toContainText('已选 0 / 4');
    await expect(choices.getByRole('checkbox')).toHaveCount(0);

    // Replace only the local metadata handler with a delayed fixture. No MCP endpoint is contacted.
    await app.evaluate(({ ipcMain }) => {
      const state = globalThis as typeof globalThis & { finishMcpList?: (value: unknown) => void };
      ipcMain.removeHandler('native:mcp-connections-list');
      ipcMain.handle('native:mcp-connections-list', () => new Promise(resolve => { state.finishMcpList = resolve; }));
    });
    await choices.getByRole('button', { name: '读取 MCP 连接', exact: true }).click();
    await expect(choices.getByRole('button', { name: '正在读取 MCP 连接…', exact: true })).toBeDisabled();
    await page.locator('.session-row').filter({ hasText: 'MCP 会话 1' }).click();
    await app.evaluate(() => {
      const state = globalThis as typeof globalThis & { finishMcpList?: (value: unknown) => void };
      state.finishMcpList?.({ connections: [{ id: 'late', name: '迟到的服务', endpoint: 'https://late.example.test/mcp', protocolVersion: '2025-11-25', revision: 1, enabled: true, ready: true, credentialConfigured: true, auth: { mode: 'none' }, allowLoopbackHttp: false }], storage: { persistentAvailable: false } });
      delete state.finishMcpList;
    });
    await expect(choices).toContainText('已选 1 / 4');
    await expect(choices).not.toContainText('迟到的服务');
    await expect(choices.getByRole('button', { name: '读取 MCP 连接', exact: true })).toBeEnabled();
    const saved = await page.evaluate(async () => (await window.desktop.snapshot()).state.sessions);
    expect(saved.find(item => item.id === sessionIds[1])?.engineConfig.options.mcpConnections).toEqual([]);
  } finally { await app.close(); await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

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

test('native connection diagnostics are opt-in, private, cancellable, and aborted on settings disposal, reload and quit', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdesk-native-diagnostics-ui-'));
  const data = path.join(directory, 'data');
  await fs.mkdir(data);
  await fs.writeFile(path.join(data, 'workspace.json'), JSON.stringify({ version: 3, projects: [], sessions: [], settings: {
    claudePath: path.join(directory, 'missing-claude'), shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000, engineDefaults: {},
  } }));
  const sentinel = 'sk-native-diagnostic-ui-SECRET-DO-NOT-RETURN';
  const privateText = 'provider-private-test-text-DO-NOT-DISPLAY';
  let mode: 'complete' | 'unauthorized' | 'stall' = 'complete';
  let requests = 0, disconnected = 0;
  const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests++; bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (mode === 'unauthorized') { response.writeHead(401); response.end(sentinel + privateText); return; }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (mode === 'stall') {
      response.on('close', () => { disconnected++; });
      response.write(': waiting for cancellation\n\n'); return;
    }
    response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_ui_probe', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: privateText }] }], usage: { input_tokens: 12, output_tokens: 1, total_tokens: 13 } } })}\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const app = await electron.launch({ args: electronLaunchArgs(), cwd: desktopRoot, env: { ...process.env, WORKBENCH_TEST_MODE: '1', WORKBENCH_DATA_DIR: data } });
  let closed = false;
  try {
    const page = await app.firstWindow();
    const openSettings = async () => {
      await page.getByRole('button', { name: '设置与连接', exact: false }).click();
      await page.getByRole('tab', { name: '连接与终端', exact: true }).click();
    };
    await openSettings();
    const region = page.getByRole('region', { name: 'Native 模型连接', exact: true });
    await region.getByRole('button', { name: '新增模型连接', exact: true }).click();
    await page.getByLabel('Native 连接名称', { exact: true }).fill('手动诊断连接');
    await page.getByLabel('Native 服务地址', { exact: true }).fill(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
    await page.getByLabel('Native 默认模型', { exact: true }).fill('fixture-model');
    await page.getByLabel('明确允许本地回环 HTTP', { exact: false }).check();
    await page.getByLabel('Native 认证方式', { exact: true }).selectOption('memory');
    await region.getByRole('button', { name: '保存模型连接', exact: true }).click();
    await page.getByLabel('Native 新的 API Key', { exact: true }).fill(sentinel);
    await region.getByRole('button', { name: '设置凭据并清空输入', exact: true }).click();
    await expect(region.locator('.connection-box')).toContainText('就绪');
    await expect(page.getByLabel('Native 新的 API Key', { exact: true })).toHaveValue('');
    await region.getByRole('button', { name: '刷新', exact: true }).click();
    const run = region.getByRole('button', { name: '测试连接（可能计费）', exact: true });
    await expect(run).toBeEnabled();
    expect(requests).toBe(0);
    await expect(region).toContainText('不代表工具调用兼容性');

    await run.click();
    await expect(region.locator('.native-connection-test-result')).toContainText('Responses 文本流测试通过');
    await expect(region.locator('.native-connection-test-result')).toContainText('合计 13 tokens');
    expect(requests).toBe(1);
    expect(bodies[0].tools).toEqual([]); expect(bodies[0].max_output_tokens).toBe(256);
    await expect(page.locator('body')).not.toContainText(privateText);
    await expect(page.locator('body')).not.toContainText(sentinel);
    const snapshot = await page.evaluate(async () => ({ connections: await window.desktop.nativeConnections.list(), workspace: await window.desktop.snapshot() }));
    expect(JSON.stringify(snapshot)).not.toContain(sentinel); expect(JSON.stringify(snapshot)).not.toContain(privateText);
    const disk = await fs.readFile(path.join(data, 'native/connections.json'), 'utf8');
    expect(disk).not.toContain(sentinel); expect(disk).not.toContain(privateText);

    mode = 'unauthorized'; await run.click();
    await expect(region.locator('.native-connection-test-result')).toContainText('认证失败');
    await expect(region.locator('.native-connection-test-result')).toContainText('HTTP 401');
    expect(requests).toBe(2);
    await expect(page.locator('body')).not.toContainText(sentinel);

    mode = 'stall'; await run.click();
    await expect.poll(() => requests).toBe(3);
    await expect(region.getByRole('button', { name: '删除', exact: true })).toBeDisabled();
    await expect(region.getByRole('button', { name: '编辑', exact: true })).toBeDisabled();
    await region.getByRole('button', { name: '取消连接测试', exact: true }).click();
    await expect(region.locator('.native-connection-test-result')).toContainText('连接测试已取消');
    await expect.poll(() => disconnected).toBe(1);
    await expect(run).toBeEnabled();

    await run.click(); await expect.poll(() => requests).toBe(4);
    await page.getByRole('tab').filter({ hasNotText: '连接与终端' }).first().click();
    await expect.poll(() => disconnected).toBe(2);
    await page.getByRole('tab', { name: '连接与终端', exact: true }).click();
    await expect(run).toBeEnabled();
    await expect(region.locator('.native-connection-test-result')).toHaveCount(0);

    await run.click(); await expect.poll(() => requests).toBe(5);
    await page.reload();
    await expect.poll(() => disconnected).toBe(3);
    await openSettings(); await expect(run).toBeEnabled();
    await run.click(); await expect.poll(() => requests).toBe(6);
    await app.close(); closed = true;
    await expect.poll(() => disconnected).toBe(4);
    expect(requests).toBe(6);
  } finally {
    if (!closed) await app.close();
    const stopped = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeAllConnections(); await stopped;
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
