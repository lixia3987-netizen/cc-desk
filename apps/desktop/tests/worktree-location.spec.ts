import { desktopRoot } from './helpers/paths';
import { sessionAction, stubChatSubmission, submitNewSession } from './helpers/session-ui';
import { electronLaunchArgs } from './helpers/electron-launch';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { LegacyAppState as AppState } from './helpers/legacy-workspace';

async function workspace() {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cc-desk-worktree-ui-')));
  const data = path.join(directory, 'data'), projectPath = path.join(directory, 'project with spaces');
  const customRoot = path.join(directory, '统一 Worktree 目录');
  await Promise.all([fs.mkdir(data), fs.mkdir(projectPath), fs.mkdir(customRoot)]);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: projectPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  // Fixture bytes must not depend on the host's checkout newline policy.
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Workbench Tests');
  git('config', 'user.email', 'tests@example.invalid');
  await fs.writeFile(path.join(projectPath, 'README.md'), 'Original project content\n');
  git('add', '.'); git('commit', '-m', 'Fixture');
  const project = { id: randomUUID(), name: 'worktree-project', path: projectPath, createdAt: new Date().toISOString() };
  const state: AppState = {
    version: 2, projects: [project], sessions: [],
    settings: { claudePath: path.join(directory, 'unavailable-claude'), shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000 },
  };
  await fs.writeFile(path.join(data, 'workspace.json'), JSON.stringify(state));
  const launch = async () => { const app = await electron.launch({
    args: electronLaunchArgs(), cwd: desktopRoot,
    env: { ...process.env, WORKBENCH_TEST_MODE: '1', WORKBENCH_DATA_DIR: data },
  }); await stubChatSubmission(app); return app; };
  return { directory, data, project, customRoot, git, launch, dispose: () => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

async function openSettings(page: Page) {
  await page.getByRole('button', { name: '设置与连接', exact: true }).click();
  await page.getByRole('tab', { name: '工作区与 IDE', exact: true }).click();
  return page.getByRole('dialog', { name: '设置与连接', exact: true });
}

/** Keep the renderer, preload and IPC real; replace only the OS picker result. */
async function pickerResult(app: ElectronApplication, selected: string | null) {
  await app.evaluate(({ dialog }, value) => {
    dialog.showOpenDialog = (async () => ({ canceled: value === null, filePaths: value === null ? [] : [value] })) as typeof dialog.showOpenDialog;
  }, selected);
}

interface SnapshotReadGate {
  captured: boolean;
  rejection?: string;
  release?: () => void;
  restore: () => void;
}

/** Delay one real IPC read so deletion cannot depend on platform timing. */
async function gateSnapshotRead(app: ElectronApplication, sessionId: string, failure?: string) {
  await app.evaluate(({ ipcMain, BrowserWindow }, { sessionId, failure }) => {
    const handlers = ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> };
    const original = handlers._invokeHandlers.get('chat:snapshot');
    if (!original) throw new Error('The real chat:snapshot handler is missing.');
    const globals = globalThis as typeof globalThis & { snapshotReadGate?: SnapshotReadGate };
    const gate: SnapshotReadGate = {
      captured: false,
      restore: () => { ipcMain.removeHandler('chat:snapshot'); ipcMain.handle('chat:snapshot', original); },
    };
    globals.snapshotReadGate = gate;
    ipcMain.removeHandler('chat:snapshot');
    ipcMain.handle('chat:snapshot', async (event, id: string) => {
      if (id !== sessionId || gate.captured) return original(event, id);
      gate.captured = true;
      await new Promise<void>(resolve => { gate.release = resolve; });
      try {
        if (failure) throw new Error(failure);
        return await original(event, id);
      } catch (error) {
        gate.rejection = error instanceof Error ? error.message : String(error);
        throw error;
      }
    });
    BrowserWindow.getAllWindows()[0].webContents.send('chat:changed', sessionId, 'idle');
  }, { sessionId, failure });
  await expect.poll(() => app.evaluate(() => (globalThis as typeof globalThis & { snapshotReadGate: SnapshotReadGate }).snapshotReadGate.captured)).toBe(true);
}

interface DeletionNotificationGate {
  deleted: boolean;
  verificationReads: number;
  release: () => void;
}

/** Keep the real deletion committed while its response and state event are in transit. */
async function gateDeletionNotification(app: ElectronApplication, sessionId: string) {
  await app.evaluate(({ ipcMain, BrowserWindow }, sessionId) => {
    const handlers = ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> };
    const originalDelete = handlers._invokeHandlers.get('session:delete')!;
    const originalSnapshot = handlers._invokeHandlers.get('workspace:snapshot')!;
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const originalSend = contents.send.bind(contents);
    let notification: unknown[] | undefined, released = false, finish: (() => void) | undefined;
    const gate: DeletionNotificationGate = { deleted: false, verificationReads: 0, release: () => {
      released = true;
      contents.send = originalSend;
      ipcMain.removeHandler('session:delete'); ipcMain.handle('session:delete', originalDelete);
      ipcMain.removeHandler('workspace:snapshot'); ipcMain.handle('workspace:snapshot', originalSnapshot);
      if (notification) originalSend('workspace:state', ...notification);
      finish?.();
    } };
    (globalThis as typeof globalThis & { deletionNotificationGate: DeletionNotificationGate }).deletionNotificationGate = gate;
    contents.send = (channel, ...args) => {
      if (!released && channel === 'workspace:state' && !args[0].sessions.some((session: { id: string }) => session.id === sessionId)) { notification = args; return; }
      originalSend(channel, ...args);
    };
    ipcMain.removeHandler('workspace:snapshot');
    ipcMain.handle('workspace:snapshot', (...args) => {
      if (gate.deleted) gate.verificationReads++;
      return originalSnapshot(...args);
    });
    ipcMain.removeHandler('session:delete');
    ipcMain.handle('session:delete', async (...args) => {
      const result = await originalDelete(...args);
      gate.deleted = true;
      if (!released) await new Promise<void>(resolve => { finish = resolve; });
      return result;
    });
  }, sessionId);
}

test('worktree location: picker edits a draft; custom and project settings survive restart', async ({}, testInfo) => {
  const f = await workspace();
  let app = await f.launch();
  try {
    let page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 680));
    let settings = await openSettings(page);
    await expect(settings.getByLabel('Worktree 位置', { exact: true })).toHaveValue('project');
    await expect(settings.getByLabel('统一 Worktree 根目录', { exact: true })).toHaveCount(0);
    await settings.getByLabel('Worktree 位置', { exact: true }).selectOption('custom');
    await pickerResult(app, f.customRoot);
    await settings.getByRole('button', { name: '选择 Worktree 目录', exact: true }).click();
    await expect(settings.getByLabel('统一 Worktree 根目录', { exact: true })).toHaveValue(f.customRoot);
    expect((await page.evaluate(() => window.desktop.snapshot())).state.settings.worktreeLocation ?? 'project').toBe('project');
    expect((await page.evaluate(() => window.desktop.snapshot())).state.settings.worktreeRoot ?? '').toBe('');
    await pickerResult(app, null);
    await settings.getByRole('button', { name: '选择 Worktree 目录', exact: true }).click();
    await expect(settings.getByLabel('统一 Worktree 根目录', { exact: true })).toHaveValue(f.customRoot);
    await settings.getByRole('button', { name: '关闭弹窗', exact: true }).click();

    settings = await openSettings(page);
    await expect(settings.getByLabel('Worktree 位置', { exact: true })).toHaveValue('project');
    await settings.getByLabel('Worktree 位置', { exact: true }).selectOption('custom');
    await expect(settings.getByLabel('统一 Worktree 根目录', { exact: true })).toHaveValue('');
    await settings.getByLabel('统一 Worktree 根目录', { exact: true }).fill(f.customRoot);
    await settings.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.desktop.snapshot())).state.settings.worktreeRoot).toBe(f.customRoot);
    await expect(settings.getByRole('button', { name: '保存设置', exact: true })).toBeEnabled();
    await settings.locator('.worktree-preferences').evaluate(element => element.scrollIntoView({ block: 'center' }));
    expect(await settings.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('worktree-settings.png') });
    await settings.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    await app.close(); app = await f.launch(); page = await app.firstWindow();

    settings = await openSettings(page);
    await expect(settings.getByLabel('Worktree 位置', { exact: true })).toHaveValue('custom');
    await expect(settings.getByLabel('统一 Worktree 根目录', { exact: true })).toHaveValue(f.customRoot);
    await settings.getByLabel('统一 Worktree 根目录', { exact: true }).fill('relative-worktree-path');
    await settings.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(settings.getByRole('alert')).toContainText('绝对路径');
    expect((await page.evaluate(() => window.desktop.snapshot())).state.settings.worktreeRoot).toBe(f.customRoot);
    await settings.getByLabel('统一 Worktree 根目录', { exact: true }).fill(f.customRoot);
    await settings.getByLabel('Worktree 位置', { exact: true }).selectOption('project');
    await settings.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.desktop.snapshot())).state.settings.worktreeLocation).toBe('project');
    await expect(settings.getByRole('button', { name: '保存设置', exact: true })).toBeEnabled();
    await app.close(); app = await f.launch(); page = await app.firstWindow();
    settings = await openSettings(page);
    await expect(settings.getByLabel('Worktree 位置', { exact: true })).toHaveValue('project');
    await expect(settings.getByLabel('统一 Worktree 根目录', { exact: true })).toHaveCount(0);
    expect(JSON.parse(await fs.readFile(path.join(f.data, 'workspace.json'), 'utf8')).settings.worktreeLocation).toBe('project');
    await expect(page.locator('.error-banner')).toHaveText([]);
  } finally { await app.close(); await f.dispose(); }
});

test('worktree location: UI creates named trees in both locations and preserves existing sessions', async ({}, testInfo) => {
  const f = await workspace(), app = await f.launch();
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 680));
    await page.getByRole('button', { name: /新建会话/ }).click();
    let form = page.getByRole('region', { name: '新建会话', exact: true });
    await form.getByLabel('会话名称', { exact: true }).fill('title-derived');
    await expect(form.getByLabel('Worktree 名称', { exact: true })).toHaveCount(0);
    await form.getByRole('checkbox', { name: /创建独立 Git worktree/ }).check();
    await expect(form.getByLabel('Worktree 名称', { exact: true })).toHaveValue('');
    await expect(form.locator('#new-worktree-location-hint')).toContainText('.claude/worktrees');
    await submitNewSession(page);
    await expect(page.getByRole('heading', { name: 'title-derived', exact: true })).toBeVisible();
    const original = (await page.evaluate(() => window.desktop.snapshot())).state.sessions.find(session => session.title === 'title-derived')!;
    expect(original.cwd).toBe(path.join(f.project.path, '.claude', 'worktrees', original.id.slice(0, 8)));
    expect(path.basename(original.cwd)).toMatch(/^[a-f0-9]{8}$/);
    expect(path.basename(original.cwd)).not.toContain(original.title);
    expect(original.worktree).toBe(original.cwd);
    expect(await fs.readFile(path.join(original.cwd, 'README.md'), 'utf8')).toBe('Original project content\n');
    expect(f.git('status', '--porcelain')).toBe('');

    // A fork must start from its source tree's HEAD but be placed beside that tree,
    // rather than accidentally nesting another .claude/worktrees inside the source.
    await fs.writeFile(path.join(original.cwd, 'fork-source.txt'), 'Committed only in the source tree\n');
    execFileSync('git', ['add', 'fork-source.txt'], { cwd: original.cwd, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'Source tree commit'], { cwd: original.cwd, stdio: 'pipe' });
    const fork = await page.evaluate(input => window.desktop.createSession({
      projectId: input.projectId, title: 'fork-child', kind: 'agent', mode: 'structured',
      engineConfig: { schemaVersion: 1, options: { model: '', effort: 'default', permissionMode: 'default' } }, isolated: true, conversationId: input.conversationId, fork: true, worktreeName: 'fork-child',
    }), { conversationId: original.execution.conversationId, projectId: f.project.id });
    expect(fork.cwd).toBe(path.join(f.project.path, '.claude', 'worktrees', `fork-child-${fork.id.slice(0, 8)}`));
    expect(fork.worktreeBase).toBe(original.cwd);
    expect(await fs.readFile(path.join(fork.cwd, 'fork-source.txt'), 'utf8')).toBe('Committed only in the source tree\n');
    expect(await fs.stat(path.join(f.project.path, 'fork-source.txt')).then(() => true, () => false)).toBe(false);

    const root = path.join(f.customRoot, 'automatically created');
    const settings = await openSettings(page);
    await settings.getByLabel('Worktree 位置', { exact: true }).selectOption('custom');
    await settings.getByLabel('统一 Worktree 根目录', { exact: true }).fill(root);
    await settings.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.desktop.snapshot())).state.settings.worktreeRoot).toBe(root);
    await expect(settings.getByRole('button', { name: '保存设置', exact: true })).toBeEnabled();
    await settings.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    expect((await page.evaluate(() => window.desktop.snapshot())).state.sessions.find(session => session.id === original.id)?.cwd).toBe(original.cwd);
    expect(await fs.stat(root).then(() => true, () => false)).toBe(false);

    await page.getByRole('button', { name: /新建会话/ }).click();
    form = page.getByRole('region', { name: '新建会话', exact: true });
    await form.getByLabel('会话名称', { exact: true }).fill('Custom display title');
    await form.getByRole('checkbox', { name: /创建独立 Git worktree/ }).check();
    await expect(form.locator('#new-worktree-location-hint')).toContainText(root);
    await form.getByLabel('Worktree 名称', { exact: true }).fill('named-tree');
    await form.locator('.new-session-worktree-options').scrollIntoViewIfNeeded();
    expect(await form.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('worktree-session.png') });
    await submitNewSession(page);
    await expect(page.getByRole('heading', { name: 'Custom display title', exact: true })).toBeVisible();
    const created = (await page.evaluate(() => window.desktop.snapshot())).state.sessions.find(session => session.title === 'Custom display title')!;
    expect(path.dirname(path.dirname(created.cwd))).toBe(root);
    expect(path.basename(path.dirname(created.cwd))).toMatch(/^worktree-project-[0-9a-f]{8}$/);
    expect(path.basename(created.cwd)).toBe(`named-tree-${created.id.slice(0, 8)}`);
    expect(created.worktreeBase).toBe(f.project.path);
    expect(created.worktree).toBe(created.cwd);
    const worktrees = f.git('worktree', 'list', '--porcelain');
    // Git uses forward slashes even when the native filesystem uses backslashes.
    expect(worktrees).toContain(`worktree ${created.cwd.replaceAll('\\', '/')}`);
    expect(worktrees).toContain(`worktree ${original.cwd.replaceAll('\\', '/')}`);

    await page.getByRole('button', { name: /新建会话/ }).click();
    form = page.getByRole('region', { name: '新建会话', exact: true });
    await form.getByRole('checkbox', { name: /创建独立 Git worktree/ }).check();
    await expect(form.getByLabel('Worktree 名称', { exact: true })).toHaveValue('');
    await page.locator('.session-row').filter({ hasText: 'Custom display title' }).click();

    await page.getByRole('button', { name: '变更', exact: true }).click();
    await expect(page.getByRole('button', { name: '清理隔离目录', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '清理隔离目录', exact: true }).click();
    await page.getByRole('button', { name: '确认清理', exact: true }).click();
    await expect.poll(() => fs.stat(created.cwd).then(() => true, () => false)).toBe(false);
    const after = (await page.evaluate(() => window.desktop.snapshot())).state.sessions;
    expect(after.find(session => session.id === created.id)?.worktree).toBeUndefined();
    expect(after.find(session => session.id === original.id)?.cwd).toBe(original.cwd);
    expect(await fs.stat(original.cwd).then(stat => stat.isDirectory())).toBe(true);
    await page.getByRole('button', { name: '关闭变更面板', exact: true }).click();
    await page.getByRole('button', { name: '变更', exact: true }).click();
    await expect(page.getByRole('region', { name: '变更面板', exact: true })).toContainText('工作目录已清理');
    expect(errors).toEqual([]);
    await expect(page.locator('.error-banner')).toHaveText([]);
  } finally { await app.close(); await f.dispose(); }
});

test('worktree branches: UI selects local or remote starts, refreshes remote refs, and preserves the dirty main checkout', async () => {
  const f = await workspace();
  let app: ElectronApplication | undefined;
  try {
    const remotePath = path.join(f.directory, 'local remote.git'), publisherPath = path.join(f.directory, 'remote publisher');
    execFileSync('git', ['init', '--bare', remotePath], { stdio: 'pipe' });
    f.git('remote', 'add', 'origin', remotePath);
    f.git('push', '-u', 'origin', 'main');
    // Apply before clone's first checkout: configuring afterward would leave
    // CRLF bytes that a later `git add .` could commit as an unrelated change.
    execFileSync('git', ['-c', 'core.autocrlf=false', 'clone', '-b', 'main', remotePath, publisherPath], { stdio: 'pipe' });
    const publishGit = (...args: string[]) => execFileSync('git', args, { cwd: publisherPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    publishGit('config', 'core.autocrlf', 'false');
    publishGit('config', 'user.name', 'Workbench Tests');
    publishGit('config', 'user.email', 'tests@example.invalid');
    publishGit('checkout', '-b', 'feature/base');
    await fs.writeFile(path.join(publisherPath, 'remote-base.txt'), 'Remote branch content\n');
    publishGit('add', '.'); publishGit('commit', '-m', 'Remote branch start');
    publishGit('push', '-u', 'origin', 'feature/base');
    f.git('fetch', 'origin');
    f.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');

    f.git('checkout', '-b', 'feature/base');
    await fs.writeFile(path.join(f.project.path, 'local-base.txt'), 'Local branch content\n');
    f.git('add', '.'); f.git('commit', '-m', 'Local branch start');
    const localHead = f.git('rev-parse', 'HEAD');
    f.git('checkout', 'main');
    const mainHead = f.git('rev-parse', 'HEAD');
    await fs.writeFile(path.join(f.project.path, 'README.md'), 'Keep uncommitted main changes\n');
    await fs.writeFile(path.join(f.project.path, 'untracked-main.txt'), 'Keep untracked main content\n');
    const mainStatus = f.git('status', '--porcelain=v1');

    app = await f.launch();
    const page = await app.firstWindow();
    await page.getByRole('button', { name: /新建会话/ }).click();
    let form = page.getByRole('region', { name: '新建会话', exact: true });
    await form.getByLabel('会话名称', { exact: true }).fill('Start from local branch');
    await form.getByRole('checkbox', { name: /创建独立 Git worktree/ }).check();
    let branches = form.getByLabel('起始分支', { exact: true });
    await expect(branches).toBeEnabled();
    await expect(branches).toHaveValue('');
    await expect(branches.locator('optgroup[label="本地分支"] option[value="refs/heads/feature/base"]')).toHaveText('feature/base');
    await expect(branches.locator('optgroup[label="远程分支"] option[value="refs/remotes/origin/feature/base"]')).toHaveText('origin/feature/base');
    await expect(branches.locator('option[value="refs/remotes/origin/HEAD"]')).toHaveCount(0);
    await branches.selectOption('refs/heads/feature/base');
    await submitNewSession(page);
    await expect(page.getByRole('heading', { name: 'Start from local branch', exact: true })).toBeVisible();
    const local = (await page.evaluate(() => window.desktop.snapshot())).state.sessions.find(session => session.title === 'Start from local branch')!;
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: local.cwd, encoding: 'utf8' }).trim()).toBe(localHead);
    expect(await fs.readFile(path.join(local.cwd, 'local-base.txt'), 'utf8')).toBe('Local branch content\n');
    expect(await fs.readFile(path.join(local.cwd, 'README.md'), 'utf8')).toBe('Original project content\n');
    expect(path.basename(local.cwd)).toMatch(/^[a-f0-9]{8}$/);
    expect(f.git('branch', '--show-current')).toBe('main');
    expect(f.git('rev-parse', 'HEAD')).toBe(mainHead);
    expect(f.git('status', '--porcelain=v1')).toBe(mainStatus);

    await page.getByRole('button', { name: /新建会话/ }).click();
    form = page.getByRole('region', { name: '新建会话', exact: true });
    await form.getByLabel('会话名称', { exact: true }).fill('Start from newly published remote branch');
    await form.getByRole('checkbox', { name: /创建独立 Git worktree/ }).check();
    branches = form.getByLabel('起始分支', { exact: true });
    await expect(branches).toBeEnabled();
    publishGit('checkout', '-b', 'feature/remote-new');
    await fs.writeFile(path.join(publisherPath, 'remote-new.txt'), 'Published after the dialog opened\n');
    publishGit('add', '.'); publishGit('commit', '-m', 'Publish a new remote branch');
    publishGit('push', '-u', 'origin', 'feature/remote-new');
    const firstRemoteHead = publishGit('rev-parse', 'HEAD');
    await expect(branches.locator('option[value="refs/remotes/origin/feature/remote-new"]')).toHaveCount(0);
    await form.getByRole('button', { name: '刷新远程分支', exact: true }).click();
    await expect(branches.locator('option[value="refs/remotes/origin/feature/remote-new"]')).toHaveText('origin/feature/remote-new');
    await branches.selectOption('refs/remotes/origin/feature/remote-new');
    expect(f.git('rev-parse', 'refs/remotes/origin/feature/remote-new')).toBe(firstRemoteHead);

    // Creating from a remote branch must fetch its latest commit, even if the
    // picker was populated before another collaborator published an update.
    await fs.writeFile(path.join(publisherPath, 'remote-new.txt'), 'Latest remote commit at creation time\n');
    publishGit('add', '.'); publishGit('commit', '-m', 'Advance the selected remote branch');
    publishGit('push');
    const latestRemoteHead = publishGit('rev-parse', 'HEAD');
    expect(latestRemoteHead).not.toBe(firstRemoteHead);
    await submitNewSession(page);
    await expect(page.getByRole('heading', { name: 'Start from newly published remote branch', exact: true })).toBeVisible();
    const remote = (await page.evaluate(() => window.desktop.snapshot())).state.sessions.find(session => session.title === 'Start from newly published remote branch')!;
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: remote.cwd, encoding: 'utf8' }).trim()).toBe(latestRemoteHead);
    expect(await fs.readFile(path.join(remote.cwd, 'remote-new.txt'), 'utf8')).toBe('Latest remote commit at creation time\n');
    expect(await fs.readFile(path.join(remote.cwd, 'remote-base.txt'), 'utf8')).toBe('Remote branch content\n');
    expect(await fs.readFile(path.join(remote.cwd, 'README.md'), 'utf8')).toBe('Original project content\n');
    expect(path.basename(remote.cwd)).toMatch(/^[a-f0-9]{8}$/);
    expect(remote.cwd).not.toBe(local.cwd);
    expect(f.git('branch', '--show-current')).toBe('main');
    expect(f.git('rev-parse', 'HEAD')).toBe(mainHead);
    expect(f.git('status', '--porcelain=v1')).toBe(mainStatus);
    expect(await fs.readFile(path.join(f.project.path, 'README.md'), 'utf8')).toBe('Keep uncommitted main changes\n');
    expect(await fs.readFile(path.join(f.project.path, 'untracked-main.txt'), 'utf8')).toBe('Keep untracked main content\n');
    expect(() => f.git('rev-parse', '--verify', 'refs/heads/feature/remote-new')).toThrow();
    await expect(page.locator('.error-banner')).toHaveText([]);
  } finally { await app?.close(); await f.dispose(); }
});

test('worktree branches: changing projects resets the selected start branch before creation', async () => {
  const f = await workspace();
  let app: ElectronApplication | undefined;
  try {
    f.git('branch', 'feature/only-first-project');
    const otherPath = path.join(f.directory, 'other project');
    execFileSync('git', ['clone', '-b', 'main', f.project.path, otherPath], { stdio: 'pipe' });
    const otherHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: otherPath, encoding: 'utf8' }).trim();
    app = await f.launch();
    const page = await app.firstWindow();
    await expect(page.getByRole('button', { name: '设置与连接', exact: true })).toBeVisible();
    const other = await page.evaluate(projectPath => window.desktop.addProject(projectPath), otherPath);
    await page.getByRole('button', { name: /新建会话/ }).click();
    const form = page.getByRole('region', { name: '新建会话', exact: true });
    await form.getByLabel('工作空间', { exact: true }).selectOption(f.project.id);
    await form.getByLabel('会话名称', { exact: true }).fill('Create in the second project');
    await form.getByRole('checkbox', { name: /创建独立 Git worktree/ }).check();
    const branches = form.getByLabel('起始分支', { exact: true });
    await branches.selectOption('refs/heads/feature/only-first-project');
    await form.getByLabel('工作空间', { exact: true }).selectOption(other.id);
    await expect(branches).toBeEnabled();
    await expect(branches).toHaveValue('');
    await expect(branches.locator('option[value="refs/heads/feature/only-first-project"]')).toHaveCount(0);
    await expect(branches.locator('option[value="refs/heads/main"]')).toHaveText('main');
    await submitNewSession(page);
    await expect(page.getByRole('heading', { name: 'Create in the second project', exact: true })).toBeVisible();
    const created = (await page.evaluate(() => window.desktop.snapshot())).state.sessions.find(session => session.title === 'Create in the second project')!;
    expect(created.projectId).toBe(other.id);
    expect(created.worktreeBase).toBe(otherPath);
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: created.cwd, encoding: 'utf8' }).trim()).toBe(otherHead);
    await expect(page.locator('.error-banner')).toHaveText([]);
  } finally { await app?.close(); await f.dispose(); }
});

test('worktree location: blocked cleanup explains why and record-only deletion preserves all files and the branch', async () => {
  const f = await workspace(), app = await f.launch();
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('button', { name: '设置与连接', exact: true })).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 680));
    await page.getByRole('button', { name: /新建会话/ }).click();
    const form = page.getByRole('region', { name: '新建会话', exact: true });
    await form.getByLabel('会话名称', { exact: true }).fill('Retain my worktree');
    await form.getByRole('checkbox', { name: /创建独立 Git worktree/ }).check();
    await submitNewSession(page);
    await expect(page.getByRole('heading', { name: 'Retain my worktree', exact: true })).toBeVisible();
    const created = (await page.evaluate(() => window.desktop.snapshot())).state.sessions.find(session => session.title === 'Retain my worktree')!;
    const git = (...args: string[]) => execFileSync('git', args, { cwd: created.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    await fs.writeFile(path.join(created.cwd, '.gitignore'), 'ignored.txt\n');
    await fs.writeFile(path.join(created.cwd, 'committed.txt'), 'Unmerged work\n');
    git('add', '.'); git('commit', '-m', 'Unmerged feature');
    await fs.writeFile(path.join(created.cwd, 'README.md'), 'Uncommitted edit\n');
    await fs.writeFile(path.join(created.cwd, 'untracked.txt'), 'Untracked data\n');
    await fs.writeFile(path.join(created.cwd, 'ignored.txt'), 'Ignored data\n');
    const head = git('rev-parse', 'HEAD'), status = git('status', '--porcelain=v1', '--ignored');
    await page.getByRole('button', { name: '变更', exact: true }).click();
    const changes = page.getByRole('region', { name: '变更面板', exact: true });
    await expect(changes.getByRole('button', { name: '清理隔离目录', exact: true })).toBeDisabled();
    await expect(changes).toContainText('暂时无法清理隔离目录');
    await expect(changes).toContainText('尚未合入 main');
    await expect(changes).toContainText('ignored.txt');
    await expect(changes).toContainText('未提交或未跟踪文件');
    await expect(changes.getByRole('button', { name: '打开隔离目录', exact: true })).toBeEnabled();
    await page.screenshot({ path: test.info().outputPath('worktree-cleanup-reasons.png') });
    await sessionAction(page, created.title, '删除会话');
    const deletion = page.getByRole('dialog', { name: '删除会话', exact: true });
    await expect(deletion).toContainText('包括未提交、未合并及被忽略的文件');
    await expect(deletion).toContainText(created.cwd);
    expect(await deletion.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('preserve-worktree-confirmation.png') });
    await deletion.getByRole('button', { name: '取消', exact: true }).click();
    expect((await page.evaluate(() => window.desktop.snapshot())).state.sessions.some(s => s.id === created.id)).toBe(true);
    expect(git('status', '--porcelain=v1', '--ignored')).toBe(status);
    await sessionAction(page, created.title, '删除会话');
    await deletion.getByRole('button', { name: '仅删除会话，保留隔离目录', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.desktop.snapshot())).state.sessions.some(s => s.id === created.id)).toBe(false);
    expect(git('status', '--porcelain=v1', '--ignored')).toBe(status);
    expect(git('rev-parse', `refs/heads/workbench/${created.id.slice(0, 8)}`)).toBe(head);
    expect(f.git('worktree', 'list', '--porcelain')).toContain(created.cwd.replaceAll('\\', '/'));
    expect(await fs.readFile(path.join(created.cwd, 'committed.txt'), 'utf8')).toBe('Unmerged work\n');
    expect(await fs.readFile(path.join(created.cwd, 'README.md'), 'utf8')).toBe('Uncommitted edit\n');
    expect(await fs.readFile(path.join(created.cwd, 'untracked.txt'), 'utf8')).toBe('Untracked data\n');
    expect(await fs.readFile(path.join(created.cwd, 'ignored.txt'), 'utf8')).toBe('Ignored data\n');
    expect(await fs.readFile(path.join(f.project.path, 'README.md'), 'utf8')).toBe('Original project content\n');
    await expect(page.locator('.error-banner')).toHaveText([]);
  } finally { await app.close(); await f.dispose(); }
});

test('worktree location: force deletion requires a typed second confirmation, cancel preserves data, and removal keeps the branch and project', async () => {
  const f = await workspace(), app = await f.launch();
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('button', { name: '设置与连接', exact: true })).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 680));
    await page.getByRole('button', { name: /新建会话/ }).click();
    const form = page.getByRole('region', { name: '新建会话', exact: true });
    await form.getByLabel('会话名称', { exact: true }).fill('Force delete temporary tree');
    await form.getByRole('checkbox', { name: /创建独立 Git worktree/ }).check();
    await submitNewSession(page);
    await expect(page.getByRole('heading', { name: 'Force delete temporary tree', exact: true })).toBeVisible();
    const created = (await page.evaluate(() => window.desktop.snapshot())).state.sessions.find(session => session.title === 'Force delete temporary tree')!;
    const git = (...args: string[]) => execFileSync('git', args, { cwd: created.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    await fs.writeFile(path.join(created.cwd, '.gitignore'), 'ignored.txt\n');
    await fs.writeFile(path.join(created.cwd, 'committed.txt'), 'Keep this unmerged commit\n');
    git('add', '.'); git('commit', '-m', 'Retained branch commit');
    const branch = `refs/heads/workbench/${created.id.slice(0, 8)}`, head = git('rev-parse', 'HEAD');
    await fs.writeFile(path.join(created.cwd, 'README.md'), 'Uncommitted edit\n');
    await fs.writeFile(path.join(created.cwd, 'untracked.txt'), 'Untracked data\n');
    await fs.writeFile(path.join(created.cwd, 'ignored.txt'), 'Ignored data\n');
    const status = git('status', '--porcelain=v1', '--ignored');
    await sessionAction(page, created.title, '删除会话');
    const deletion = page.getByRole('dialog', { name: '删除会话', exact: true });
    const forceOption = deletion.getByRole('button', { name: '删除会话并强制删除隔离目录', exact: true });
    await forceOption.click();
    const dialog = page.getByRole('dialog', { name: '强制删除隔离目录', exact: true });
    const typed = dialog.getByLabel('输入“删除”以确认', { exact: true }), confirm = dialog.getByRole('button', { name: '确认强制删除', exact: true });
    await expect(dialog).toContainText(created.cwd);
    await expect(dialog).toContainText('未提交修改、未跟踪文件和被忽略的文件都会丢失');
    await expect(dialog).toContainText('Git 分支和其中已经提交的内容会保留');
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await expect(page.locator('#root')).toHaveJSProperty('inert', true);
    await expect(confirm).toBeDisabled();
    await typed.fill('delete'); await expect(confirm).toBeDisabled();
    await typed.fill('删除'); await expect(confirm).toBeEnabled();
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect((await page.evaluate(() => window.desktop.snapshot())).state.sessions.some(session => session.id === created.id)).toBe(true);
    expect(git('status', '--porcelain=v1', '--ignored')).toBe(status);
    expect(await fs.readFile(path.join(created.cwd, 'ignored.txt'), 'utf8')).toBe('Ignored data\n');
    await sessionAction(page, created.title, '删除会话');
    await forceOption.click();
    await expect(typed).toHaveValue('');
    await typed.fill('删除');
    await dialog.getByRole('button', { name: '返回', exact: true }).click();
    await expect(deletion).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await forceOption.click();
    await expect(typed).toHaveValue('');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect((await page.evaluate(() => window.desktop.snapshot())).state.sessions.some(session => session.id === created.id)).toBe(true);
    expect(git('status', '--porcelain=v1', '--ignored')).toBe(status);
    await sessionAction(page, created.title, '删除会话');
    await forceOption.click();
    await expect(typed).toHaveValue(''); await expect(confirm).toBeDisabled();
    await typed.fill('删除');
    await page.screenshot({ path: test.info().outputPath('force-worktree-confirmation.png') });
    await confirm.click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await page.evaluate(() => window.desktop.snapshot())).state.sessions.some(session => session.id === created.id)).toBe(false);
    expect(await fs.stat(created.cwd).then(() => true, () => false)).toBe(false);
    expect(f.git('worktree', 'list', '--porcelain')).not.toContain(created.cwd.replaceAll('\\', '/'));
    expect(f.git('rev-parse', branch)).toBe(head);
    expect(f.git('show', `${branch}:committed.txt`)).toBe('Keep this unmerged commit');
    expect(await fs.readFile(path.join(f.project.path, 'README.md'), 'utf8')).toBe('Original project content\n');
    await expect(page.locator('.error-banner')).toHaveText([]);
  } finally { await app.close(); await f.dispose(); }
});

for (const damage of ['missing-git', 'missing-directory'] as const) {
  test(`worktree location: force deletion recovers an owned external worktree with ${damage} and preserves its branch`, async () => {
    const f = await workspace(), app = await f.launch();
    try {
      const page = await app.firstWindow();
      await expect(page.getByRole('button', { name: '设置与连接', exact: true })).toBeVisible();
      const settings = await openSettings(page);
      await settings.getByLabel('Worktree 位置', { exact: true }).selectOption('custom');
      await settings.getByLabel('统一 Worktree 根目录', { exact: true }).fill(f.customRoot);
      await settings.getByRole('button', { name: '保存设置', exact: true }).click();
      await expect.poll(async () => (await page.evaluate(() => window.desktop.snapshot())).state.settings.worktreeRoot).toBe(f.customRoot);
      await expect(settings.getByRole('button', { name: '保存设置', exact: true })).toBeEnabled();
      await settings.getByRole('button', { name: '关闭弹窗', exact: true }).click();
      await page.getByRole('button', { name: /新建会话/ }).click();
      const form = page.getByRole('region', { name: '新建会话', exact: true });
      const title = 'Damaged external tree ' + damage;
      await form.getByLabel('会话名称', { exact: true }).fill(title);
      await form.getByRole('checkbox', { name: /创建独立 Git worktree/ }).check();
      await submitNewSession(page);
      await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
      const created = (await page.evaluate(() => window.desktop.snapshot())).state.sessions.find(session => session.title === title)!;
      expect(path.dirname(path.dirname(created.cwd))).toBe(f.customRoot);
      const git = (...args: string[]) => execFileSync('git', args, { cwd: created.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      const branch = `refs/heads/workbench/${created.id.slice(0, 8)}`;
      await fs.writeFile(path.join(created.cwd, 'retained-commit.txt'), 'Committed before metadata damage\n');
      git('add', '.'); git('commit', '-m', 'Keep damaged worktree branch');
      const head = git('rev-parse', 'HEAD');
      await fs.writeFile(path.join(created.cwd, 'untracked.txt'), 'Explicitly discarded local data\n');
      if (damage === 'missing-git') {
        await fs.rm(path.join(created.cwd, '.git'));
        // Outside the source project, Git cannot accidentally find a parent
        // repository; this reproduces the user's failing root-discovery call.
        expect(() => git('--literal-pathspecs', 'rev-parse', '--show-toplevel')).toThrow(/not a git repository/);
      } else {
        await fs.rm(created.cwd, { recursive: true });
      }
      expect(f.git('worktree', 'list', '--porcelain')).toContain(created.cwd.replaceAll('\\', '/'));
      await sessionAction(page, created.title, '删除会话');
      await page.getByRole('dialog', { name: '删除会话', exact: true }).getByRole('button', { name: '删除会话并强制删除隔离目录', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '强制删除隔离目录', exact: true });
      await expect(dialog).toContainText(created.cwd);
      await dialog.getByLabel('输入“删除”以确认', { exact: true }).fill('删除');
      await dialog.getByRole('button', { name: '确认强制删除', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect.poll(async () => (await page.evaluate(() => window.desktop.snapshot())).state.sessions.some(session => session.id === created.id)).toBe(false);
      expect(await fs.stat(created.cwd).then(() => true, () => false)).toBe(false);
      expect(f.git('worktree', 'list', '--porcelain')).not.toContain(created.cwd.replaceAll('\\', '/'));
      expect(f.git('rev-parse', branch)).toBe(head);
      expect(f.git('show', `${branch}:retained-commit.txt`)).toBe('Committed before metadata damage');
      expect(await fs.readFile(path.join(f.project.path, 'README.md'), 'utf8')).toBe('Original project content\n');
      await expect(page.locator('.error-banner')).toHaveText([]);
    } finally { await app.close(); await f.dispose(); }
  });
}

test('session deletion: stale snapshot failures do not replace the workspace, while active read failures remain visible', async () => {
  const f = await workspace(), app = await f.launch();
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('button', { name: '设置与连接', exact: true })).toBeVisible();
    const created = await page.evaluate(async projectId => {
      const session = await window.desktop.createSession({ projectId, title: 'Snapshot lifecycle', kind: 'agent', providerId: 'claude', mode: 'structured', engineConfig: { schemaVersion: 1, options: { model: '', effort: 'default', permissionMode: 'default' } }, isolated: false });
      await window.desktop.setSelection(session.id);
      return session;
    }, f.project.id);
    await expect(page.getByRole('heading', { name: created.title, exact: true })).toBeVisible();
    const activeFailure = 'Active snapshot read failed';
    await gateSnapshotRead(app, created.id, activeFailure);
    await app.evaluate(() => (globalThis as typeof globalThis & { snapshotReadGate: SnapshotReadGate }).snapshotReadGate.release!());
    await expect(page.locator('.chat-pane [role=alert]')).toContainText(activeFailure);
    await app.evaluate(() => (globalThis as typeof globalThis & { snapshotReadGate: SnapshotReadGate }).snapshotReadGate.restore());

    await page.getByRole('button', { name: '重新同步状态', exact: true }).click();
    await expect(page.locator('.chat-pane [role=alert]')).toHaveCount(0);
    await gateSnapshotRead(app, created.id);
    await sessionAction(page, created.title, '删除会话');
    await page.getByRole('dialog', { name: '删除会话', exact: true }).getByRole('button', { name: '确认删除会话', exact: true }).click();
    await expect(page.getByRole('heading', { name: created.title, exact: true })).toHaveCount(0);
    await expect.poll(async () => (await page.evaluate(() => window.desktop.snapshot())).state.sessions.some(session => session.id === created.id)).toBe(false);
    await app.evaluate(() => (globalThis as typeof globalThis & { snapshotReadGate: SnapshotReadGate }).snapshotReadGate.release!());
    await expect.poll(() => app.evaluate(() => (globalThis as typeof globalThis & { snapshotReadGate: SnapshotReadGate }).snapshotReadGate.rejection)).toBe('会话不存在。');
    // Round-trip after the rejected response, then allow React to commit. This
    // proves the obsolete catch ran; an immediate absence assertion could race it.
    await page.evaluate(async () => {
      await window.desktop.snapshot();
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    await expect(page.locator('.error-banner')).toHaveText([]);
    await app.evaluate(() => (globalThis as typeof globalThis & { snapshotReadGate: SnapshotReadGate }).snapshotReadGate.restore());
  } finally { await app.close(); await f.dispose(); }
});

test('session deletion: a committed deletion invalidates reads before its delayed UI notification unmounts the pane', async () => {
  const f = await workspace(), app = await f.launch();
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('button', { name: '设置与连接', exact: true })).toBeVisible();
    const created = await page.evaluate(async projectId => {
      const session = await window.desktop.createSession({ projectId, title: 'Deletion notification race', kind: 'agent', providerId: 'claude', mode: 'structured', engineConfig: { schemaVersion: 1, options: { model: '', effort: 'default', permissionMode: 'default' } }, isolated: false });
      await window.desktop.setSelection(session.id);
      return session;
    }, f.project.id);
    const heading = page.getByRole('heading', { name: created.title, exact: true });
    await expect(heading).toBeVisible();
    await gateSnapshotRead(app, created.id);
    await gateDeletionNotification(app, created.id);
    await sessionAction(page, created.title, '删除会话');
    await page.getByRole('dialog', { name: '删除会话', exact: true }).getByRole('button', { name: '确认删除会话', exact: true }).click();
    await expect.poll(() => app.evaluate(() => (globalThis as typeof globalThis & { deletionNotificationGate: DeletionNotificationGate }).deletionNotificationGate.deleted)).toBe(true);
    await expect(heading).toBeVisible();
    await app.evaluate(() => (globalThis as typeof globalThis & { snapshotReadGate: SnapshotReadGate }).snapshotReadGate.release!());
    await expect.poll(() => app.evaluate(() => (globalThis as typeof globalThis & { snapshotReadGate: SnapshotReadGate }).snapshotReadGate.rejection)).toBe('会话不存在。');
    // Deletion invalidated this read before IPC began; the late rejection must
    // remain suppressed even before the workspace event or delete reply arrives.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(heading).toBeVisible();
    await expect(page.locator('.chat-pane [role=alert]')).toHaveCount(0);
    await expect(page.locator('.error-banner')).toHaveText([]);
    await app.evaluate(() => (globalThis as typeof globalThis & { deletionNotificationGate: DeletionNotificationGate }).deletionNotificationGate.release());
    await expect(heading).toHaveCount(0);
    expect((await page.evaluate(() => window.desktop.snapshot())).state.sessions.some(session => session.id === created.id)).toBe(false);
    await expect(page.locator('.error-banner')).toHaveText([]);
  } finally {
    await app.evaluate(() => {
      const globals = globalThis as typeof globalThis & { snapshotReadGate?: SnapshotReadGate; deletionNotificationGate?: DeletionNotificationGate };
      globals.snapshotReadGate?.release?.(); globals.snapshotReadGate?.restore(); globals.deletionNotificationGate?.release();
    }).catch(() => {});
    await app.close(); await f.dispose();
  }
});
