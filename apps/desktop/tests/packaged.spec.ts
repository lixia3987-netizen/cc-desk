import { electronLaunchArgs } from './helpers/electron-launch';
import { desktopRoot } from './helpers/paths';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { extractFile, listPackage } from '@electron/asar';

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
  // Claim this previously absent directory exclusively before the app can read
  // it. EEXIST is a failure, including a race with another process creating it.
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
      // Do not delete a profile while its process may still be using it. A
      // failed launch with no observable child leaves evidence for the CI run.
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
      // Assert isolation before the renderer is allowed to perform any test mutation.
      expect(identity.packaged).toBe(true);
      expect(identity.arch).toBe(target.arch);
      expect(await fs.realpath(identity.profile)).toBe(await fs.realpath(profile));
      expect(identity.appPath).toMatch(/[/\\][Rr]esources[/\\]app\.asar$/);
      expect(await fs.realpath(identity.executable)).toBe(await fs.realpath(target.executable));
      // A workspace root manifest must never become the installed application's
      // identity: Electron also derives the default profile name from this name.
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
      // Playwright disposes its application channel on close; retain the native
      // child handle while that channel is still available to inspect real exit status.
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
      // A release must not retain stale bundled font files from an earlier build.
      const archivePath = await app!.evaluate(({app}) => app.getAppPath());
      expect(listPackage(archivePath,{isPack:false}).filter(file => /@fontsource-variable|font-licenses|noto-(?:sans|serif)-sc|jetbrains-mono/.test(file))).toEqual([]);
      expect((await page.evaluate(() => window.desktop.snapshot())).state.sessions).toHaveLength(0);
      // Native folder dialogs are outside Playwright; use the application's normal validated IPC.
      await page.evaluate(p => window.desktop.addProject(p), project);
      await page.getByRole('button', { name: /新建会话/ }).click();
      await page.getByLabel('会话名称', { exact: true }).fill('打包程序终端验证');
      await page.getByRole('button', { name: 'Shell 终端', exact: true }).click();
      await page.getByRole('button', { name: '创建会话', exact: true }).click();
      await page.getByRole('button', { name: '启动会话', exact: true }).click();
      await expect(page.locator('.status-tag').first()).toContainText('运行中');
      const suffix = randomUUID().replaceAll('-', '');
      const marker = `PACKAGED_PTY_OK_${suffix}`;
      // The full marker never appears in the typed command, so input echo cannot pass this test.
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
      await page.getByRole('button', { name: '停止', exact: true }).click();
      await expect(page.locator('.status-tag').first()).toContainText('已停止');
      await page.screenshot({ path: testInfo.outputPath('packaged-terminal.png') });
      await close();

      const persisted = JSON.parse(await fs.readFile(path.join(profile, 'workspace.json'), 'utf8'));
      expect(persisted.sessions).toHaveLength(1);
      expect(persisted.sessions[0].title).toBe('打包程序终端验证');
      expect(persisted.sessions[0].status).toBe('stopped');
      // Older version-1 workspaces lack these optional fields. Keep their existing
      // project, session identity and transcript, then reopen with the packaged app.
      delete persisted.settings.notifications;
      delete persisted.settings.closeToTray;
      persisted.version = 1;
      for (const session of persisted.sessions) {
        session.claudeId = session.execution.conversationId ?? randomUUID();
        session.kind = session.kind === 'agent' ? 'claude' : 'shell';
        delete session.execution;
        for (const key of ['adapter', 'draft', 'taskState', 'terminalSync', 'identityPending']) delete session[key];
      }
      await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify(persisted));
      page = await launch();
      await expect(page.getByRole('button', { name: /打包程序终端验证.*已停止/ })).toBeVisible();
      const state = (await page.evaluate(() => window.desktop.snapshot())).state;
      expect(state.projects).toHaveLength(1);
      expect(state.projects[0].path).toBe(await fs.realpath(project));
      expect(state.sessions).toHaveLength(1);
      expect(state.sessions[0].id).toBe(persisted.sessions[0].id);
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
