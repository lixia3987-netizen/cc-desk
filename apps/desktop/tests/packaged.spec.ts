import { electronLaunchArgs } from './helpers/electron-launch';
import { closeNativeApp } from './helpers/native-app-cleanup';
import { desktopRoot } from './helpers/paths';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { extractFile, listPackage } from '@electron/asar';
import { persistedStateSchema as legacyWorkspaceSchema } from '../src/shared/workspace-v2';
// @ts-expect-error 共享的仅限回环访问协议测试装置由 JavaScript 实现。
import { startResponsesFixture } from '../../../packages/agent-node/tests/fixtures/responses-server.mjs';

type Target = { format: string; artifact: string; executable: string; arch: string };
const manifest = process.env.WORKBENCH_PACKAGED_TARGETS;
if (!manifest) throw new Error('Run node scripts/verify-packaged.mjs to extract and test release packages.');
const targets = JSON.parse(readFileSync(manifest, 'utf8')) as Target[];
if (!targets.length) throw new Error('No packaged executables were supplied.');
const desktopManifest = JSON.parse(readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'));

test('packaged default profile: unchanged application identity and userData without an override', async () => {
  test.skip(process.env.GITHUB_ACTIONS !== 'true', 'Default-profile verification requires an expendable GitHub Actions user; local runs keep explicit isolated profiles.');
  const appData = process.platform === 'win32' ? process.env.APPDATA
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support')
      : process.platform === 'linux' ? process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config') : undefined;
  if (!appData || !path.isAbsolute(appData)) throw new Error('The CI user must expose an absolute platform appData directory.');
  await fs.mkdir(appData, { recursive: true });
  const canonicalAppData = await fs.realpath(appData);
  const profile = path.join(canonicalAppData, 'Claude Workbench');
  try {
    await fs.lstat(profile);
    throw new Error(`Refusing default-profile verification: a profile already exists at ${profile}.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // 应用读取前，以独占方式创建此前不存在的目录。包括其他进程
  // 同时创建该目录的竞争情况在内，EEXIST 都表示失败。
  await fs.mkdir(profile, { mode: 0o700 });
  const ownedProfile = await fs.lstat(profile);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-default-profile-'));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(?:WORKBENCH_|CLAUDE|ANTHROPIC|ELECTRON_RUN_AS_NODE|NODE_OPTIONS)/i.test(key)) env[key] = value;
  }
  const claudeConfig = path.join(directory, 'claude');
  await fs.mkdir(claudeConfig);
  env.CLAUDE_CONFIG_DIR = claudeConfig;
  let app: ElectronApplication | undefined;
  let child: ReturnType<ElectronApplication['process']> | undefined;
  let launchAttempted = false;
  try {
    launchAttempted = true;
    app = await electron.launch({ executablePath: targets[0].executable, args: electronLaunchArgs([]), env, cwd: directory, timeout: 45_000 });
    child = app.process();
    const identity = await app.evaluate(({ app }) => ({
      packaged: app.isPackaged, name: app.getName(), version: app.getVersion(),
      appData: app.getPath('appData'), profile: app.getPath('userData'),
      override: app.commandLine.hasSwitch('user-data-dir'),
    }));
    expect(identity.packaged).toBe(true);
    expect(identity.override).toBe(false);
    expect(identity.name).toBe('Claude Workbench');
    expect(identity.version).toBe(desktopManifest.version);
    expect(await fs.realpath(identity.appData)).toBe(canonicalAppData);
    expect(await fs.realpath(identity.profile)).toBe(profile);
    const page = await app.firstWindow();
    await page.waitForFunction(() => !!window.desktop);
    const snapshot = await page.evaluate(() => window.desktop.snapshot());
    expect(await fs.realpath(snapshot.dataPath)).toBe(profile);
    expect(snapshot.state.projects).toEqual([]);
    expect(snapshot.state.sessions).toEqual([]);
    await app.close();
    app = undefined;
    expect(child.exitCode).toBe(0);
    expect(child.signalCode).toBeNull();
  } finally {
    try {
      if (app) await app.close();
    } finally {
      // 进程可能仍在使用用户配置目录时，不要删除它。启动失败且没有
      // 可观察到的子进程时，应为 CI 运行保留证据。
      if (!launchAttempted || (child && (child.exitCode !== null || child.signalCode !== null))) {
        const current = await fs.lstat(profile);
        if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== ownedProfile.dev || current.ino !== ownedProfile.ino) {
          throw new Error('The owned default profile was replaced; refusing to remove it.');
        }
        await fs.rm(profile, { recursive: true, maxRetries: 5, retryDelay: 200 });
        await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    }
  }
});

for (const target of targets) {
  test(`packaged ${target.format}: native ASAR worker completes an approved local task without Claude`, async ({}, testInfo) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-native-packaged-'));
    const profile = path.join(directory, '用户 profile with spaces');
    const project = path.join(directory, '项目 with spaces');
    const isolatedHome = path.join(directory, 'home');
    const config = path.join(directory, 'config');
    const localAppData = path.join(directory, 'local-appdata');
    const claudeConfig = path.join(directory, 'claude');
    await Promise.all([profile, project, isolatedHome, config, localAppData, claudeConfig].map(p => fs.mkdir(p, { recursive: true })));
    await fs.writeFile(path.join(project, 'fixture.txt'), 'before packaged native task\n');
    await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ version: 3, projects: [], sessions: [], settings: {
      claudePath: path.join(directory, 'missing-claude'), shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000, engineDefaults: {},
    } }));
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !/^(?:WORKBENCH_|CLAUDE|ANTHROPIC|OPENAI|ELECTRON_RUN_AS_NODE|NODE_OPTIONS)/i.test(key)) env[key] = value;
    }
    Object.assign(env, { HOME: isolatedHome, USERPROFILE: isolatedHome, APPDATA: config, LOCALAPPDATA: localAppData, XDG_CONFIG_HOME: config, CLAUDE_CONFIG_DIR: claudeConfig });
    const content = '打包 native 任务完成 ✅\n';
    const commandMarker = 'packaged-native-command-' + randomUUID();
    const fixture = await startResponsesFixture({ task: {
      path: 'fixture.txt', content,
      // 这是 Playwright 的 Node 宿主，而非打包后的 Electron 图形界面可执行文件。
      command: { executable: process.execPath, argv: ['-e', 'require("node:fs").writeFileSync("command-result.txt", process.argv[1]);', commandMarker], cwd: '.' },
    } });
    const secret = 'sk-packaged-native-dummy-' + randomUUID();
    const errors: string[] = [];
    let app: ElectronApplication | undefined;
    let launchedProcess: ReturnType<ElectronApplication['process']> | undefined;
    const launch = async () => {
      app = await electron.launch({ executablePath: target.executable, args: electronLaunchArgs([`--user-data-dir=${profile}`]), env, cwd: directory, timeout: 45_000 });
      launchedProcess = app.process();
      const identity = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, profile: app.getPath('userData'), appPath: app.getAppPath(), arch: process.arch }));
      expect(identity.packaged).toBe(true);
      expect(identity.arch).toBe(target.arch);
      expect(await fs.realpath(identity.profile)).toBe(await fs.realpath(profile));
      expect(identity.appPath).toMatch(/[/\\][Rr]esources[/\\]app\.asar$/);
      expect(listPackage(identity.appPath, { isPack: false }).map(file => file.replaceAll('\\', '/'))).toContain('/dist/native/worker.cjs');
      // ASAR 遍历使用宿主的 path.sep，Windows 上也是如此。
      expect(extractFile(identity.appPath, path.join('dist', 'native', 'worker.cjs')).length).toBeGreaterThan(1024);
      const page = await app.firstWindow();
      page.on('pageerror', error => errors.push(error.message));
      await expect(page.locator('main.workspace')).toBeVisible();
      return page;
    };
    const close = async () => {
      const child = launchedProcess!;
      await closeNativeApp(app!); app = undefined; launchedProcess = undefined;
      expect(child.exitCode).toBe(0);
      expect(child.signalCode).toBeNull();
    };
    try {
      let page = await launch();
      const created = await page.evaluate(async ({ folder, baseURL, secret }) => {
        const connection = await window.desktop.nativeConnections.upsert({
          name: 'Packaged local fixture', protocol: 'responses', baseURL, model: 'packaged-fixture-model',
          allowLoopbackHttp: true, enabled: true, auth: { mode: 'memory' },
        });
        await window.desktop.nativeConnections.setCredential({ id: connection.id, revision: connection.revision, mode: 'memory', secret });
        const project = await window.desktop.addProject(folder);
        const session = await window.desktop.createSession({ projectId: project.id, title: '打包 native 任务', kind: 'agent', providerId: 'native', mode: 'structured', isolated: false,
          engineConfig: { schemaVersion: 1, options: { connectionId: connection.id, model: '', maxActiveMs: 60_000 } } });
        await window.desktop.setSelection(session.id);
        await window.desktop.submitChat(session.id, '读取 fixture.txt，修改内容并运行验证命令。');
        return { session, connectionId: connection.id };
      }, { folder: project, baseURL: fixture.baseURL, secret });
      const sessionId = created.session.id;
      await expect.poll(() => page.evaluate(async id => (await window.desktop.chatSnapshot(id)).pending[0]?.toolName, sessionId)).toBe('apply_patch');
      expect(await fs.readFile(path.join(project, 'fixture.txt'), 'utf8')).toBe('before packaged native task\n');
      // 在真实 Electron 实用工作进程等待正常 IPC 审批时观察它。
      // 执行器和工作进程启动都不替换为测试实现。
      const utility = await app!.evaluate(({ app }) => app.getAppMetrics().find(metric => metric.type === 'Utility' && (metric.name === 'cc-desk native agent' || metric.serviceName === 'cc-desk native agent')));
      expect(utility?.pid).toBeGreaterThan(0);
      expect(utility?.pid).not.toBe(launchedProcess!.pid);
      await page.evaluate(async id => {
        const approval = (await window.desktop.chatSnapshot(id)).pending[0];
        await window.desktop.respondChat(id, approval.requestId, { behavior: 'allow' });
      }, sessionId);
      await expect.poll(() => page.evaluate(async id => (await window.desktop.chatSnapshot(id)).pending[0]?.toolName, sessionId)).toBe('run_command');
      expect(await fs.readFile(path.join(project, 'fixture.txt'), 'utf8')).toBe(content);
      await expect(fs.stat(path.join(project, 'command-result.txt'))).rejects.toThrow();
      await page.evaluate(async id => {
        const approval = (await window.desktop.chatSnapshot(id)).pending[0];
        await window.desktop.respondChat(id, approval.requestId, { behavior: 'allow' });
      }, sessionId);
      await expect.poll(() => page.evaluate(async id => (await window.desktop.chatSnapshot(id)).taskState, sessionId), { timeout: 30_000 }).toBe('completed');
      expect(await fs.readFile(path.join(project, 'command-result.txt'), 'utf8')).toBe(commandMarker);
      const chat = await page.evaluate(id => window.desktop.chatSnapshot(id), sessionId);
      expect(chat.messages.filter(message => message.role === 'assistant').map(message => message.text).join('\n')).toContain('本地任务完成 ✅ command=completed');
      expect(chat.pending).toEqual([]);
      expect(fixture.errors).toEqual([]);
      expect(fixture.requests).toHaveLength(4);
      expect(fixture.requests.every((request: { model: string }) => request.model === 'packaged-fixture-model')).toBe(true);
      await expect.poll(() => app!.evaluate(({ app }, pid) => app.getAppMetrics().some(metric => metric.pid === pid), utility!.pid)).toBe(false);
      const publicState = await page.evaluate(() => Promise.all([window.desktop.snapshot(), window.desktop.nativeConnections.list()]));
      expect(JSON.stringify([publicState, chat])).not.toContain(secret);
      await testInfo.attach('packaged-native-worker.json', { contentType: 'application/json', body: Buffer.from(JSON.stringify({ target: target.format, archiveWorker: 'dist/native/worker.cjs', utilityPid: utility!.pid, requests: fixture.requests.length, taskState: chat.taskState }, null, 2)) });
      await page.screenshot({ path: testInfo.outputPath('packaged-native.png') });
      await close();
      expect(await fs.readFile(path.join(profile, 'native', 'connections.json'), 'utf8')).not.toContain(secret);
      expect(await fs.readFile(path.join(profile, 'workspace.json'), 'utf8')).not.toContain(secret);
      const journal = await fs.readFile(path.join(profile, 'native', 'conversations', created.session.execution.conversationId!, 'journal.jsonl'), 'utf8');
      expect(journal).not.toContain(secret);
      expect(journal).toContain('"type":"run_finished"');
      page = await launch();
      const restored = await page.evaluate(async ({ sessionId, connectionId }) => ({
        chat: await window.desktop.chatSnapshot(sessionId), readiness: await window.desktop.nativeConnections.readiness({ id: connectionId }),
        state: (await window.desktop.snapshot()).state,
      }), { sessionId, connectionId: created.connectionId });
      expect(restored.chat.messages.filter(message => message.role === 'assistant').map(message => message.text).join('\n')).toContain('本地任务完成 ✅ command=completed');
      expect(restored.readiness.ready).toBe(false);
      expect(restored.readiness.error).toContain('凭据');
      expect(restored.state.sessions.find(session => session.id === sessionId)?.execution).toEqual(created.session.execution);
      expect(fixture.requests).toHaveLength(4);
      expect(errors).toEqual([]);
      await close();
    } finally {
      try {
        if (app) await closeNativeApp(app);
        await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } finally { await fixture.close(); }
    }
  });

  test(`packaged ${target.format}: PTY, persistence, second instance and quit`, async ({}, testInfo) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-packaged-'));
    const profile = path.join(directory, 'profile');
    const project = path.join(directory, '项目 with spaces');
    const isolatedHome = path.join(directory, 'home');
    const config = path.join(directory, 'config');
    const localAppData = path.join(directory, 'local-appdata');
    const claudeConfig = path.join(directory, 'claude');
    await Promise.all([profile, project, isolatedHome, config, localAppData, claudeConfig].map(p => fs.mkdir(p, { recursive: true })));
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !/^(?:WORKBENCH_|CLAUDE|ANTHROPIC|ELECTRON_RUN_AS_NODE|NODE_OPTIONS)/i.test(key)) env[key] = value;
    }
    Object.assign(env, {
      HOME: isolatedHome, USERPROFILE: isolatedHome, APPDATA: config,
      LOCALAPPDATA: localAppData, XDG_CONFIG_HOME: config, CLAUDE_CONFIG_DIR: claudeConfig,
    });
    const args = electronLaunchArgs([`--user-data-dir=${profile}`]);
    let app: ElectronApplication | undefined;
    let launchedProcess: ReturnType<ElectronApplication['process']> | undefined;
    const errors: string[] = [];
    const launch = async () => {
      const launched = await electron.launch({ executablePath: target.executable, args, env, cwd: directory, timeout: 45_000 });
      app = launched;
      launchedProcess = launched.process();
      const identity = await launched.evaluate(({ app }) => ({
        packaged: app.isPackaged, arch: process.arch, profile: app.getPath('userData'),
        appPath: app.getAppPath(), executable: process.execPath, name: app.getName(), version: app.getVersion(),
      }));
      // 允许渲染进程执行任何测试修改前，先断言隔离状态。
      expect(identity.packaged).toBe(true);
      expect(identity.arch).toBe(target.arch);
      expect(await fs.realpath(identity.profile)).toBe(await fs.realpath(profile));
      expect(identity.appPath).toMatch(/[/\\][Rr]esources[/\\]app\.asar$/);
      expect(await fs.realpath(identity.executable)).toBe(await fs.realpath(target.executable));
      // 工作区根目录清单绝不能成为已安装应用的标识；
      // Electron 还会从该名称推导默认用户配置目录名。
      expect(identity.name).toBe('Claude Workbench');
      expect(identity.version).toBe(desktopManifest.version);
      const packagedManifest = JSON.parse(extractFile(identity.appPath, 'package.json').toString('utf8'));
      expect(packagedManifest.name).toBe('claude-workbench');
      expect(packagedManifest.productName).toBe('Claude Workbench');
      expect(packagedManifest.version).toBe(desktopManifest.version);
      expect(packagedManifest.main).toBe('dist/main/index.cjs');
      const page = await launched.firstWindow();
      page.on('pageerror', error => errors.push(error.message));
      await page.waitForFunction(() => !!window.desktop);
      const snapshot = await page.evaluate(() => window.desktop.snapshot());
      expect(await fs.realpath(snapshot.dataPath)).toBe(await fs.realpath(profile));
      return page;
    };
    const close = async () => {
      const launched = app!;
      // Playwright 关闭时会销毁应用通道；须在通道仍可用时保留原生
      // 子进程句柄，以检查真实退出状态。
      const child = launchedProcess!;
      await launched.close();
      app = undefined;
      launchedProcess = undefined;
      expect(child.exitCode).toBe(0);
      expect(child.signalCode).toBeNull();
    };
    try {
      let page = await launch();
      await expect(page.getByRole('heading', { name: /让每个想法/ })).toBeVisible();
      // 发布版本不能保留先前构建中捆绑的过期字体文件。
      const archivePath = await app!.evaluate(({app}) => app.getAppPath());
      expect(listPackage(archivePath,{isPack:false}).filter(file => /@fontsource-variable|font-licenses|noto-(?:sans|serif)-sc|jetbrains-mono/.test(file))).toEqual([]);
      expect((await page.evaluate(() => window.desktop.snapshot())).state.sessions).toHaveLength(0);
      // 原生文件夹对话框不受 Playwright 控制；使用应用正常且经过校验的 IPC。
      // 首次发送页面将新任务限制为结构化 Agent 引擎后，
      // 仍通过已校验的 IPC 支持现有 Shell 会话。
      await page.evaluate(async p => {
        const project = await window.desktop.addProject(p);
        const session = await window.desktop.createSession({ projectId: project.id, title: '打包程序终端验证', kind: 'shell', providerId: 'shell', mode: 'terminal', engineConfig: { schemaVersion: 1, options: {} }, isolated: false });
        await window.desktop.setSelection(session.id);
      }, project);
      await expect(page.getByRole('heading', { name: '打包程序终端验证', exact: true })).toBeVisible();
      await page.getByRole('button', { name: '启动会话', exact: true }).click();
      await expect(page.locator('.status-tag').first()).toContainText('运行中');
      const suffix = randomUUID().replaceAll('-', '');
      const marker = `PACKAGED_PTY_OK_${suffix}`;
      // 输入的命令中不会出现完整标记，因此单靠输入回显不能通过本测试。
      const command = process.platform === 'win32'
        ? `Write-Output ('PACKAGED_' + 'PTY_OK_${suffix}')`
        : `printf '\\n%s%s\\n' 'PACKAGED_' 'PTY_OK_${suffix}'`;
      await page.locator('.terminal-host').click();
      await page.keyboard.type(command);
      await page.keyboard.press('Enter');
      await expect.poll(() => page.evaluate(async () => {
        const snapshot = await window.desktop.snapshot();
        return (await window.desktop.terminalSnapshot(snapshot.state.sessions[0].id)).chunks.map(chunk => chunk.data).join('');
      })).toContain(marker);
      await page.getByLabel('终端操作', { exact: true }).click(); await page.getByRole('button', { name: '关闭终端', exact: true }).click();
      await expect(page.locator('.status-tag').first()).toContainText('已停止');
      await page.screenshot({ path: testInfo.outputPath('packaged-terminal.png') });
      await close();

      const workspaceFile = path.join(profile, 'workspace.json');
      const persisted = JSON.parse(await fs.readFile(workspaceFile, 'utf8'));
      expect(persisted.version).toBe(3);
      expect(persisted.sessions).toHaveLength(1);
      expect(persisted.sessions[0].title).toBe('打包程序终端验证');
      expect(persisted.sessions[0].status).toBe('stopped');
      // 较早的第 1 版工作区缺少这些可选字段。保留现有项目、
      // 会话标识和对话记录，再使用打包应用重新打开。
      delete persisted.settings.notifications;
      delete persisted.settings.closeToTray;
      delete persisted.settings.engineDefaults;
      persisted.settings.defaultPermissionMode = 'default';
      persisted.version = 1;
      for (const session of persisted.sessions) {
        // 此测试装置通过已校验的 Shell IPC 创建。第 1 版 Shell 仍要求
        // 旧的通用字段，尽管它从未使用 Claude 选项。
        expect(session.kind).toBe('shell');
        expect(session.engineConfig).toEqual({ schemaVersion: 1, options: {} });
        Object.assign(session, { model: '', effort: 'default', permissionMode: 'default' });
        delete session.engineConfig;
        session.claudeId = session.execution.conversationId ?? randomUUID();
        session.kind = session.kind === 'agent' ? 'claude' : 'shell';
        delete session.execution;
        for (const key of ['adapter', 'draft', 'taskState', 'terminalSync', 'identityPending']) delete session[key];
      }
      // 检查未经修改的历史读取器，不将第 1 版输入替换为转换后的
      // 第 2 版输出。应用必须执行真实迁移。
      expect(legacyWorkspaceSchema.parse(persisted).version).toBe(2);
      const legacyBytes = Buffer.from(JSON.stringify(persisted, null, 4) + '\n');
      await fs.writeFile(workspaceFile, legacyBytes);
      page = await launch();
      await expect(page.getByRole('button', { name: /打包程序终端验证.*已停止/ })).toBeVisible();
      const state = (await page.evaluate(() => window.desktop.snapshot())).state;
      expect(state.version).toBe(3);
      expect(state.settings.engineDefaults.claude).toEqual({ schemaVersion: 1, options: { model: '', effort: 'default', permissionMode: 'default' } });
      expect(state.settings.notifications).toBeUndefined();
      expect(state.settings.closeToTray).toBeUndefined();
      expect(state.projects).toHaveLength(1);
      expect(state.projects[0].path).toBe(await fs.realpath(project));
      expect(state.sessions).toHaveLength(1);
      expect(state.sessions[0].id).toBe(persisted.sessions[0].id);
      expect(state.sessions[0].execution).toEqual({ providerId: 'shell', mode: 'terminal' });
      expect(state.sessions[0].engineConfig).toEqual({ schemaVersion: 1, options: {} });
      for (const key of ['model', 'effort', 'permissionMode', 'claudeId']) expect(state.sessions[0]).not.toHaveProperty(key);
      // 迁移在关键保存或刷新之前仍有未保存修改。通过正常的打包应用 IPC
      // 执行两次独立保存：第二次轮换 .bak，但不得更改
      // 不可变且逐字节保留的第 3 版之前备份。
      await page.evaluate(id => window.desktop.updateSession({ id, title: '打包程序终端验证 · v3' }), state.sessions[0].id);
      const backups = async () => (await fs.readdir(profile)).filter(name => name.startsWith('workspace.pre-v3.')).sort();
      const migrationBackups = await backups();
      expect(migrationBackups).toHaveLength(1);
      expect(migrationBackups[0]).toMatch(/^workspace\.pre-v3\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i);
      const migrationBackup = path.join(profile, migrationBackups[0]);
      expect(await fs.readFile(migrationBackup)).toEqual(legacyBytes);
      const migratedDisk = JSON.parse(await fs.readFile(workspaceFile, 'utf8'));
      expect(migratedDisk.version).toBe(3);
      expect(migratedDisk.sessions[0].engineConfig).toEqual(state.sessions[0].engineConfig);
      await page.evaluate(id => window.desktop.updateSession({ id, title: '打包程序终端验证' }), state.sessions[0].id);
      expect(JSON.parse(await fs.readFile(workspaceFile + '.bak', 'utf8')).version).toBe(3);
      expect(await backups()).toEqual(migrationBackups);
      expect(await fs.readFile(migrationBackup)).toEqual(legacyBytes);
      expect((await page.evaluate(async () => {
        const snapshot = await window.desktop.snapshot();
        return (await window.desktop.terminalSnapshot(snapshot.state.sessions[0].id)).chunks.map(chunk => chunk.data).join('');
      }))).toContain(marker);

      await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
      expect(await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false);
      const second = spawn(target.executable, args, { env, cwd: directory, stdio: 'ignore' });
      try {
        await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
        await expect.poll(() => second.exitCode).toBe(0);
        expect(await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
        expect((await page.evaluate(() => window.desktop.snapshot())).state.sessions).toHaveLength(1);
      } finally {
        if (second.exitCode === null) second.kill();
      }
      expect(errors).toEqual([]);
      await close();
      // 使用相同的真实可执行文件，重新打开已持久化的第 3 版工作区。
      // 不能再次迁移或额外创建不可变备份。
      page = await launch();
      const restored = (await page.evaluate(() => window.desktop.snapshot())).state;
      expect(restored.version).toBe(3);
      expect(restored.sessions).toHaveLength(1);
      expect(restored.sessions[0].id).toBe(state.sessions[0].id);
      expect(restored.sessions[0].title).toBe('打包程序终端验证');
      expect(restored.sessions[0].execution).toEqual(state.sessions[0].execution);
      expect(restored.sessions[0].engineConfig).toEqual(state.sessions[0].engineConfig);
      expect(restored.settings.engineDefaults).toEqual(state.settings.engineDefaults);
      expect(await backups()).toEqual(migrationBackups);
      expect(await fs.readFile(migrationBackup)).toEqual(legacyBytes);
      expect(errors).toEqual([]);
      await close();
      expect(JSON.parse(await fs.readFile(workspaceFile, 'utf8')).version).toBe(3);
      expect(await backups()).toEqual(migrationBackups);
      expect(await fs.readFile(migrationBackup)).toEqual(legacyBytes);
    } finally {
      if (app) {
        const page = app.windows()[0];
        if (page && !page.isClosed()) {
          await page.screenshot({ path: testInfo.outputPath('failure.png') }).catch(() => {});
          await page.evaluate(async () => {
            for (const session of (await window.desktop.snapshot()).state.sessions) await window.desktop.stopSession(session.id);
          }).catch(() => {});
        }
        await app.close().catch(() => launchedProcess?.kill());
      }
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
}
