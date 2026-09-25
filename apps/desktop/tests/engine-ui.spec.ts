import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { desktopRoot, repositoryRoot } from './helpers/paths';
import { electronLaunchArgs } from './helpers/electron-launch';
import { cliUpdateFixture } from './fixtures/cli-updater';

interface FixtureControls {
  available: boolean;
  historyStarted: string[];
  releaseHistory(query: string): void;
  refresh(): void;
}

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdesk-engine-ui-'));
  const data = path.join(directory, 'profile'), cwd = path.join(directory, 'project'), projectId = randomUUID();
  await fs.mkdir(data); await fs.mkdir(cwd);
  // Keep the entire test application outside desktop/dist so failed tests can
  // never leak their extra executor into an electron-builder artifact. This
  // location still resolves the repository's external node-pty installation.
  const cache = path.join(repositoryRoot, 'node_modules/.cache');
  await fs.mkdir(cache, { recursive: true });
  const testApp = await fs.mkdtemp(path.join(cache, 'ccdesk-engine-ui-'));
  const bundle = path.join(testApp, 'main/index.cjs');
  const dispose = async () => { await fs.rm(testApp, { recursive: true, force: true }); await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); };
  try {
    await Promise.all(['preload', 'renderer'].map(name => fs.cp(path.join(desktopRoot, 'dist', name), path.join(testApp, name), { recursive: true })));
    let redirected = 0;
    await build({ absWorkingDir: desktopRoot, entryPoints: ['src/main/index.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: bundle,
      external: ['electron', 'node-pty'], plugins: [{ name: 'test-only-engine-composition', setup(builder) {
        builder.onResolve({ filter: /^\.\/execution\/(create-executors|history-sources)$/ }, args => {
          if (path.resolve(args.importer) !== path.join(desktopRoot, 'src/main/index.ts')) return undefined;
          redirected++; return { path: path.join(desktopRoot, 'tests/fixtures/engine-ui.ts') };
        });
      } }] });
    expect(redirected).toBe(2);
    expect(await fs.readFile(path.join(desktopRoot, 'dist/main/index.cjs'), 'utf8')).not.toContain('test.native');
    await fs.writeFile(path.join(data, 'workspace.json'), JSON.stringify({ version: 3,
      projects: [{ id: projectId, name: '独立引擎项目', path: cwd, createdAt: new Date().toISOString() }], sessions: [],
      settings: { claudePath: path.join(directory, 'missing-claude'), shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000,
        engineDefaults: { claude: { schemaVersion: 1, options: { model: '', effort: 'default', permissionMode: 'plan' } } } },
    }));
    return { directory, data, cwd, projectId,
      launch: async (env: NodeJS.ProcessEnv = {}) => {
        try { return await electron.launch({ args: electronLaunchArgs([bundle]), cwd: desktopRoot, env: { ...process.env, ...env, WORKBENCH_TEST_MODE: '1', WORKBENCH_DATA_DIR: data } }); }
        catch (error) { await dispose(); throw error; }
      },
      dispose,
    };
  } catch (error) { await dispose(); throw error; }
}

async function stopAndClose(app: ElectronApplication) {
  const page = app.windows()[0];
  if (page && !page.isClosed()) await page.evaluate(async () => {
    for (const session of (await window.desktop.snapshot()).state.sessions) {
      if (session.status === 'running' || session.status === 'stopping') await window.desktop.stopSession(session.id);
    }
  });
  await app.close();
}
const active = async (page: Page) => JSON.parse(await page.evaluate(async () => {
  const { state } = await window.desktop.snapshot(); return JSON.stringify(state.sessions.find(item => item.id === state.selectedSessionId));
}));
const send = async (page: Page, text: string) => { await page.getByLabel('提示词编辑器', { exact: true }).fill(text); await page.getByLabel('提示词编辑器', { exact: true }).press('Enter'); };

test('engine UI uses heterogeneous configuration, real service execution and refreshed capabilities without Claude', async () => {
  const f = await fixture(); let app = await f.launch();
  try {
    let page = await app.firstWindow();
    await page.getByRole('button', { name: '新建会话', exact: false }).click();
    await expect(page.getByLabel('权限模式', { exact: true })).toHaveValue('plan');
    await page.getByRole('button', { name: '测试 Native', exact: true }).click();
    await expect(page.getByLabel('权限模式', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('模型', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('交互方式').locator('option')).toHaveCount(1);
    await page.getByLabel('会话名称').fill('异构引擎会话');
    await page.getByLabel('路由', { exact: true }).fill('project-route');
    await page.getByLabel('回复风格', { exact: true }).selectOption('expanded');
    await page.getByRole('button', { name: '创建会话', exact: true }).click();
    const first = await active(page);
    expect(first.execution.providerId).toBe('test.native');
    expect(first.execution.conversationId).toMatch(/^native\//);
    expect(first.engineConfig).toEqual({ schemaVersion: 7, options: { route: 'project-route', responseStyle: 'expanded' } });
    expect(first).not.toHaveProperty('permissionMode');
    await expect(page.getByRole('button', { name: '添加附件', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeDisabled();
    await page.getByLabel('提示词编辑器', { exact: true }).fill('hello');
    await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeEnabled();
    await send(page, 'hello');
    await expect(page.locator('.chat-message.assistant')).toContainText('测试引擎完成：hello');
    await send(page, 'approve');
    await expect(page.getByRole('region', { name: '工具审批' })).toBeVisible();
    await app.evaluate(() => { const controls = (globalThis as unknown as { __p2EngineFixture: FixtureControls }).__p2EngineFixture; controls.available = false; controls.refresh(); });
    await expect(page.locator('.engine-unavailable')).toContainText('测试引擎暂时离线');
    await expect(page.locator('.chat-composer .engine-unavailable')).toBeVisible();
    await expect(page.getByRole('region', { name: '工具审批' })).toBeVisible();
    await page.getByRole('button', { name: '允许本次', exact: true }).click();
    await expect(page.locator('.chat-message.assistant').last()).toContainText('测试审批已完成');
    await app.evaluate(() => { const controls = (globalThis as unknown as { __p2EngineFixture: FixtureControls }).__p2EngineFixture; controls.available = true; controls.refresh(); });
    await expect(page.locator('.engine-unavailable')).toHaveCount(0);
    await send(page, 'hold');
    await expect(page.locator('.thinking-indicator')).toBeVisible();
    await send(page, 'queued message');
    await expect(page.locator('.queued-chat-message')).toContainText('queued message');
    await page.locator('.chat-composer').getByRole('button', { name: '中断', exact: true }).click();
    // Interrupted turns remain queued deliberately: remove the inspected old
    // turn before explicitly continuing the still-unsent second message.
    const interrupted = page.locator('.queued-chat-message').filter({ hasText: 'hold' });
    await interrupted.hover();
    await interrupted.getByRole('button', { name: /^移除排队消息/ }).click();
    await expect(interrupted).toHaveCount(0);
    await page.getByRole('button', { name: '继续发送队列', exact: true }).click();
    await expect(page.locator('.chat-message.assistant').last()).toContainText('测试引擎完成：queued message');
    await page.getByRole('button', { name: '工作流', exact: true }).click();
    await page.getByLabel('工作流目标', { exact: true }).fill('独立引擎完成三阶段');
    await page.getByRole('button', { name: '创建工作流', exact: true }).click();
    await page.getByRole('button', { name: '开始', exact: true }).click();
    await expect(page.locator('.workflow-stage.completed')).toHaveCount(1);
    await page.getByRole('button', { name: '继续', exact: true }).click();
    await expect(page.locator('.workflow-stage.completed')).toHaveCount(2);
    await page.getByRole('button', { name: '继续', exact: true }).click();
    await expect(page.locator('.workflow-stage.completed')).toHaveCount(3);
    await page.getByLabel('会话路由', { exact: true }).fill('saved-route');
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect.poll(async () => (await active(page)).engineConfig.options.route).toBe('saved-route');

    await app.evaluate(() => { const controls = (globalThis as unknown as { __p2EngineFixture: FixtureControls }).__p2EngineFixture; controls.available = false; controls.refresh(); });
    await expect(page.locator('.engine-unavailable')).toContainText('测试引擎暂时离线');
    await page.getByLabel('提示词编辑器', { exact: true }).fill('/offline draft');
    await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeDisabled();
    await expect(page.locator('.slash-menu')).toHaveCount(0);
    await app.evaluate(() => { const controls = (globalThis as unknown as { __p2EngineFixture: FixtureControls }).__p2EngineFixture; controls.available = true; controls.refresh(); });
    await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeEnabled();
    await expect(page.locator('.engine-unavailable')).toHaveCount(0);

    await page.getByRole('button', { name: '设置与连接', exact: false }).click();
    await page.getByRole('tab', { name: '会话与权限', exact: true }).click();
    const defaults = page.locator('.settings-section').filter({ has: page.getByRole('heading', { name: '测试 Native 默认配置', exact: true }) });
    await defaults.getByLabel('默认路由', { exact: true }).fill('new-default');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(page.getByText('设置已保存', { exact: true })).toBeVisible();
    await expect(page.locator('.settings-save-state')).toHaveText('设置已同步');
    await page.evaluate(async () => {
      const { state } = await window.desktop.snapshot(), config = state.settings.engineDefaults['test.native'];
      // A semantically identical re-save may reconstruct both provider and option order.
      await window.desktop.saveSettings({ ...state.settings, engineDefaults: { ...state.settings.engineDefaults,
        'test.native': { schemaVersion: config.schemaVersion, options: Object.fromEntries(Object.entries(config.options).reverse()) },
      } });
    });
    await expect(page.locator('.settings-save-state')).toHaveText('设置已同步');
    await page.keyboard.press('Escape');
    expect((await active(page)).engineConfig.options.route).toBe('saved-route');
    await stopAndClose(app); app = await f.launch(); page = await app.firstWindow();
    await expect(page.getByLabel('会话路由', { exact: true })).toHaveValue('saved-route');
    await expect(page.locator('.chat-message.assistant').filter({ hasText: '测试审批已完成' })).toHaveCount(1);
    await page.getByRole('button', { name: '新建会话', exact: false }).click();
    await page.getByRole('button', { name: '测试 Native', exact: true }).click();
    await expect(page.getByLabel('路由', { exact: true })).toHaveValue('new-default');
    await page.keyboard.press('Escape');
    await expect(page.locator('.error-banner')).toHaveCount(0);
  } finally { await stopAndClose(app); await f.dispose(); }
});

test('engine history ignores stale source results and unknown configurations retain passive local records', async () => {
  const f = await fixture();
  const unknownId = randomUUID(), futureId = randomUUID(), now = new Date().toISOString();
  const workspace = JSON.parse(await fs.readFile(path.join(f.data, 'workspace.json'), 'utf8'));
  workspace.settings.engineDefaults.claude = { schemaVersion: 99, options: { future: { alpha: 'preserve', beta: [1, 2] }, extra: true } };
  workspace.sessions = [
    { id: unknownId, providerId: 'vendor.missing', title: '缺失引擎记录', schemaVersion: 42 },
    { id: futureId, providerId: 'test.native', title: '未来配置记录', schemaVersion: 99 },
  ].map(value => ({ id: value.id, projectId: f.projectId, title: value.title, kind: 'agent', cwd: f.cwd,
    execution: { providerId: value.providerId, mode: 'structured', conversationId: 'opaque/preserved:identity' },
    engineConfig: { schemaVersion: value.schemaVersion, options: { future: { nested: ['preserve', 7] } } },
    started: true, status: 'stopped', taskState: 'interrupted', archived: false, createdAt: now, updatedAt: now }));
  workspace.selectedSessionId = unknownId;
  await fs.writeFile(path.join(f.data, 'workspace.json'), JSON.stringify(workspace));
  await fs.mkdir(path.join(f.data, 'chat'));
  for (const id of [unknownId, futureId]) await fs.writeFile(path.join(f.data, 'chat', id + '.json'), JSON.stringify({ sessionId: id, taskState: 'waiting_approval',
    messages: [{ id: 'saved-message', turnId: 'old-turn', role: 'assistant', text: '已保存的独立引擎记录', createdAt: now }],
    pending: [{ requestId: 'expired', kind: 'permission', toolName: 'OldTool', input: {}, createdAt: now }],
  }));
  const app = await f.launch();
  try {
    const page = await app.firstWindow();
    await expect(page.locator('.chat-message.assistant')).toContainText('已保存的独立引擎记录');
    // Unknown defaults must not block unrelated preferences. IPC serialization
    // may rebuild either the outer options or nested objects in a new key order.
    await page.evaluate(async () => {
      const { state } = await window.desktop.snapshot();
      await window.desktop.saveSettings({ ...state.settings, fontSize: 15 });
    });
    const savedPreferences = await page.evaluate(async () => {
      const { state } = await window.desktop.snapshot(), config = state.settings.engineDefaults.claude;
      await window.desktop.saveSettings({ ...state.settings, fontSize: 16, engineDefaults: { ...state.settings.engineDefaults,
        claude: { schemaVersion: config.schemaVersion, options: { extra: true, future: { beta: [1, 2], alpha: 'preserve' } } },
      } });
      return (await window.desktop.snapshot()).state.settings;
    });
    expect(savedPreferences.fontSize).toBe(16);
    expect(savedPreferences.engineDefaults.claude).toEqual(workspace.settings.engineDefaults.claude);
    await expect(page.evaluate(async () => {
      const { state } = await window.desktop.snapshot(), config = state.settings.engineDefaults.claude;
      await window.desktop.saveSettings({ ...state.settings, fontSize: 17, engineDefaults: { ...state.settings.engineDefaults,
        claude: { ...config, options: { ...config.options, extra: false } },
      } });
    })).rejects.toThrow('此引擎配置版本不受支持');
    const rejectedPreferences = await page.evaluate(async () => (await window.desktop.snapshot()).state.settings);
    expect(rejectedPreferences.fontSize).toBe(16);
    expect(rejectedPreferences.engineDefaults.claude).toEqual(workspace.settings.engineDefaults.claude);
    await expect(page.locator('.approval-card')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '删除会话', exact: true })).toBeDisabled();
    await expect(page.locator('.chat-composer .engine-unavailable')).toBeVisible();
    await page.getByRole('button', { name: '继续输入', exact: true }).click();
    await expect(page.getByLabel('提示词编辑器', { exact: true })).toBeFocused();
    await page.getByLabel('提示词编辑器', { exact: true }).fill('/retained draft');
    await expect(page.locator('.slash-menu')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '重命名', exact: true }).click();
    await page.getByLabel('新的会话名称', { exact: true }).fill('保留未知引擎');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    expect((await active(page)).engineConfig).toEqual(workspace.sessions[0].engineConfig);
    await page.locator('.session-row').filter({ hasText: '未来配置记录' }).click();
    await expect(page.locator('.engine-unavailable')).toContainText('配置版本 99');
    await expect(page.locator('.chat-message.assistant')).toContainText('已保存的独立引擎记录');
    await expect(page.getByRole('button', { name: '保存配置', exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: '导入引擎历史', exact: false }).click();
    await page.getByLabel('历史来源').selectOption('test.native');
    await page.getByLabel('搜索历史全文').fill('delayed-success');
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __p2EngineFixture: FixtureControls }).__p2EngineFixture.historyStarted.includes('delayed-success'))).toBe(true);
    await page.getByLabel('历史来源').selectOption('test.archive');
    await expect(page.locator('.history-list')).toContainText('Archive 原始历史');
    await app.evaluate(() => (globalThis as unknown as { __p2EngineFixture: FixtureControls }).__p2EngineFixture.releaseHistory('delayed-success'));
    await expect(page.locator('.history-list')).not.toContainText('Native 原始历史');
    await page.getByLabel('搜索历史全文').fill('');
    await page.getByLabel('历史来源').selectOption('test.native');
    await page.getByLabel('搜索历史全文').fill('delayed-error');
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __p2EngineFixture: FixtureControls }).__p2EngineFixture.historyStarted.includes('delayed-error'))).toBe(true);
    await page.getByLabel('历史来源').selectOption('test.archive');
    await expect(page.locator('.history-list')).toContainText('Archive 原始历史');
    await app.evaluate(() => (globalThis as unknown as { __p2EngineFixture: FixtureControls }).__p2EngineFixture.releaseHistory('delayed-error'));
    await page.locator('.history-list button').click();
    await expect(page.getByLabel('会话路由', { exact: true })).toBeVisible();
    expect((await active(page)).execution).toMatchObject({ providerId: 'test.archive', conversationId: 'opaque/shared:history', imported: true });
    await expect(page.locator('.error-banner')).toHaveCount(0);
    await expect(page.locator('.modal-error')).toHaveCount(0);
  } finally { await stopAndClose(app); await f.dispose(); }
});

test('CLI maintenance keeps the other engine reachable through the actual UI', async () => {
  const f = await fixture(), cli = await cliUpdateFixture(f.directory);
  const release = path.join(f.directory, 'release-installer'), started = path.join(f.directory, 'installer-started');
  const script = path.join(cli.prefix, 'node_modules/@anthropic-ai/claude-code/cli.js');
  const original = await fs.readFile(script, 'utf8');
  const timer = "setTimeout(()=>{fs.writeFileSync(versionFile,'2.1.10');process.exit(0);},mode==='slow'?2500:800);return;";
  expect(original).toContain(timer);
  await fs.writeFile(script, original.replace(timer, `fs.writeFileSync(${JSON.stringify(started)},'started');const barrier=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(release)}))return;clearInterval(barrier);fs.writeFileSync(versionFile,'2.1.10');process.exit(0);},20);return;`));
  const file = path.join(f.data, 'workspace.json'), workspace = JSON.parse(await fs.readFile(file, 'utf8'));
  workspace.settings.claudePath = cli.cli; await fs.writeFile(file, JSON.stringify(workspace));
  const app = await f.launch({ CLAUDE_CONFIG_DIR: cli.config });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: '新建会话', exact: false }).click();
    await page.getByRole('button', { name: '测试 Native', exact: true }).click();
    await page.getByLabel('会话名称').fill('维护期间独立运行');
    await page.getByRole('button', { name: '创建会话', exact: true }).click();
    await expect(page.getByRole('heading', { name: '维护期间独立运行', exact: true })).toBeVisible();
    await page.evaluate(projectId => window.desktop.createSession({ projectId, title: '等待维护的 Claude', kind: 'agent', providerId: 'claude', mode: 'structured', isolated: false }).then(session => session.id), f.projectId);
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox; });
    const update = page.getByRole('region', { name: 'Claude Code CLI 更新' });
    await expect(update).toContainText('2.1.10');
    await update.getByRole('button', { name: '更新 CLI…', exact: true }).click();
    await expect.poll(() => fs.readFile(started, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).toBe('started');
    await expect.poll(() => page.evaluate(async () => (await window.desktop.snapshot()).cliUpdate.phase)).toBe('updating');
    await send(page, 'maintenance message');
    await expect(page.locator('.chat-message.assistant')).toContainText('测试引擎完成：maintenance message');
    await page.locator('.session-row').filter({ hasText: '等待维护的 Claude' }).click();
    await expect(page.locator('.engine-unavailable')).toContainText('正在维护');
    await expect(page.locator('.chat-composer .engine-unavailable')).toBeVisible();
    await page.getByLabel('提示词编辑器', { exact: true }).fill('维护时保存的草稿');
    await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '新建会话', exact: false }).click();
    await expect(page.getByRole('button', { name: '创建会话', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '测试 Native', exact: true }).click();
    await expect(page.getByRole('button', { name: '创建会话', exact: true })).toBeEnabled();
    await page.keyboard.press('Escape');
    await page.locator('.session-row').filter({ hasText: '维护期间独立运行' }).click();
    await expect(page.locator('.engine-unavailable')).toHaveCount(0);
    await send(page, 'still available');
    await expect(page.locator('.chat-message.assistant').last()).toContainText('测试引擎完成：still available');
    await fs.writeFile(release, 'continue');
    await expect.poll(() => page.evaluate(async () => (await window.desktop.snapshot()).cliUpdate.phase)).toBe('updated');
    await expect(page.locator('.error-banner')).toHaveCount(0);
  } finally { await fs.writeFile(release, 'continue'); await stopAndClose(app); await f.dispose(); }
});
