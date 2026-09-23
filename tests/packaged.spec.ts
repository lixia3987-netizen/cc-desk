import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { extractFile } from '@electron/asar';

type Target = { format: string; artifact: string; executable: string; arch: string };
const manifest = process.env.WORKBENCH_PACKAGED_TARGETS;
if (!manifest) throw new Error('Run node scripts/verify-packaged.mjs to extract and test release packages.');
const targets = JSON.parse(readFileSync(manifest, 'utf8')) as Target[];
if (!targets.length) throw new Error('No packaged executables were supplied.');

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
    const args = [`--user-data-dir=${profile}`, ...(process.platform === 'linux' ? ['--no-sandbox', `--ozone-platform=${process.env.DISPLAY ? 'x11' : 'headless'}`, '--disable-gpu'] : [])];
    let app: ElectronApplication | undefined;
    let launchedProcess: ReturnType<ElectronApplication['process']> | undefined;
    const errors: string[] = [];
    const launch = async () => {
      const launched = await electron.launch({ executablePath: target.executable, args, env, cwd: directory, timeout: 45_000 });
      app = launched;
      launchedProcess = launched.process();
      const identity = await launched.evaluate(({ app }) => ({
        packaged: app.isPackaged, arch: process.arch, profile: app.getPath('userData'),
        appPath: app.getAppPath(), executable: process.execPath,
      }));
      // Assert isolation before the renderer is allowed to perform any test mutation.
      expect(identity.packaged).toBe(true);
      expect(identity.arch).toBe(target.arch);
      expect(await fs.realpath(identity.profile)).toBe(await fs.realpath(profile));
      expect(identity.appPath).toMatch(/[/\\][Rr]esources[/\\]app\.asar$/);
      expect(await fs.realpath(identity.executable)).toBe(await fs.realpath(target.executable));
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
      // Exercise the actual packaged font URLs, not the development node_modules tree.
      expect(await page.evaluate(async () => {
        const families = ['Noto Sans SC Variable','Noto Serif SC Variable','JetBrains Mono Variable'];
        for (const family of families) {
          const faces = await document.fonts.load('16px "'+family+'"','中文 Aa 123');
          if (!faces.length || faces.some(face=>face.status!=='loaded')) return false;
        }
        return true;
      })).toBe(true);
      const archivePath = await app!.evaluate(({app}) => app.getAppPath());
      const notices = ['noto-sans-sc','noto-serif-sc','jetbrains-mono'].map(family => extractFile(archivePath,path.join('dist','renderer','font-licenses',family+'-OFL.txt')).toString('utf8'));
      for (const notice of notices) expect(notice).toContain('SIL OPEN FONT LICENSE');
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
      for (const session of persisted.sessions) {
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
