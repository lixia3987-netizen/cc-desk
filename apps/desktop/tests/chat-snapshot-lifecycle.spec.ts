import { desktopRoot } from './helpers/paths';
import { sessionAction } from './helpers/session-ui';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import type { IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppState, Session } from '../src/shared/types';
import type { ChatSnapshot } from '../src/shared/chat';
import { electronLaunchArgs } from './helpers/electron-launch';

interface ReadFixture {
  armRead(id: string): void;
  readEntered(): boolean;
  readCount(id: string): number;
  releaseRead(error?: string, value?: ChatSnapshot): void;
  armDelete(): void;
  deleteEntered(): boolean;
  releaseDelete(error?: string): void;
  dispose(): void;
}
type FixtureGlobal = typeof globalThis & { sessionReadFixture: ReadFixture };

async function workspace() {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cc-desk-snapshot-lifecycle-')));
  const data = path.join(directory, 'data'), projectPath = path.join(directory, 'project');
  await fs.mkdir(projectPath); await fs.mkdir(path.join(data, 'chat'), { recursive: true });
  const now = new Date().toISOString(), projectId = randomUUID();
  const sessions: Session[] = ['快照会话 A', '快照会话 B'].map(title => ({
    id: randomUUID(), projectId, title, titleSource: 'manual', kind: 'agent', cwd: projectPath,
    execution: { providerId: 'claude', mode: 'structured', conversationId: randomUUID() },
    started: false, engineConfig: { schemaVersion: 1, options: { model: '', effort: 'default', permissionMode: 'default' } }, status: 'idle', taskState: 'idle',
    draft: '', archived: false, createdAt: now, updatedAt: now,
  }));
  const state: AppState = {
    version: 3, projects: [{ id: projectId, name: '快照项目', path: projectPath, createdAt: now }], sessions,
    selectedSessionId: sessions[0].id,
    settings: { engineDefaults: {}, claudePath: path.join(directory, 'unavailable-claude'), shellPath: '', maxSessions: 4, fontSize: 14, scrollback: 8000 },
  };
  await fs.writeFile(path.join(data, 'workspace.json'), JSON.stringify(state));
  for (const session of sessions) {
    const snapshot: ChatSnapshot = { sessionId: session.id, taskState: 'idle', pending: [], messages: [
      { id: randomUUID(), turnId: 'saved', role: 'user', text: session.title + '已有记录', createdAt: now },
    ] };
    await fs.writeFile(path.join(data, 'chat', session.id + '.json'), JSON.stringify(snapshot));
  }
  const app = await electron.launch({ args: electronLaunchArgs(), cwd: desktopRoot, env: { ...process.env, WORKBENCH_TEST_MODE: '1', WORKBENCH_DATA_DIR: data } });
  const page = await app.firstWindow();
  await expect(page.getByRole('heading', { name: sessions[0].title, exact: true })).toBeVisible();
  await expect(page.locator('.chat-message.user')).toContainText(sessions[0].title + '已有记录');

  // The test wraps the handlers Electron registered, preserving real validation,
  // deletion, persistence and state events. Only response timing is controlled.
  await app.evaluate(({ ipcMain }) => {
    type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
    // Electron 44 stores invoke handlers here; fail clearly if its test-only
    // interception surface changes when the pinned Electron version is upgraded.
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, Handler> })._invokeHandlers;
    if (!(handlers instanceof Map)) throw new Error('Electron IPC invoke handler interception is unavailable');
    const snapshot = handlers.get('chat:snapshot'), remove = handlers.get('session:delete');
    if (!snapshot || !remove) throw new Error('Expected the real session IPC handlers');
    let read: { id: string; entered: boolean; resolve?: (value: unknown) => void; reject?: (error: Error) => void } | undefined;
    let deletion: { entered: boolean; resolve?: () => void; reject?: (error: Error) => void } | undefined;
    const counts = new Map<string, number>();
    ipcMain.removeHandler('chat:snapshot');
    ipcMain.handle('chat:snapshot', (event, id: string) => {
      counts.set(id, (counts.get(id) ?? 0) + 1);
      if (read?.id === id && !read.entered) {
        read.entered = true;
        return new Promise((resolve, reject) => { read!.resolve = resolve; read!.reject = reject; });
      }
      return snapshot(event, id);
    });
    ipcMain.removeHandler('session:delete');
    ipcMain.handle('session:delete', async (event, input: unknown) => {
      if (deletion && !deletion.entered) {
        deletion.entered = true;
        await new Promise<void>((resolve, reject) => { deletion!.resolve = resolve; deletion!.reject = reject; });
      }
      return remove(event, input);
    });
    (globalThis as FixtureGlobal).sessionReadFixture = {
      armRead: id => { if (read) throw new Error('A snapshot gate is already armed'); read = { id, entered: false }; },
      readEntered: () => !!read?.entered,
      readCount: id => counts.get(id) ?? 0,
      releaseRead: (error, value) => {
        const pending = read; read = undefined;
        if (!pending?.entered) throw new Error('No snapshot request reached the gate');
        if (error) pending.reject!(new Error(error)); else pending.resolve!(value);
      },
      armDelete: () => { if (deletion) throw new Error('A deletion gate is already armed'); deletion = { entered: false }; },
      deleteEntered: () => !!deletion?.entered,
      releaseDelete: error => {
        const pending = deletion; deletion = undefined;
        if (!pending?.entered) throw new Error('No deletion request reached the gate');
        if (error) pending.reject!(new Error(error)); else pending.resolve!();
      },
      dispose: () => { read?.reject?.(new Error('fixture disposed')); deletion?.reject?.(new Error('fixture disposed')); },
    };
  });
  return { app, page, sessions, close: async () => {
    await app.evaluate(() => (globalThis as FixtureGlobal).sessionReadFixture.dispose()).catch(() => {});
    await app.close(); await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } };
}

async function holdSnapshot(app: ElectronApplication, id: string) {
  await app.evaluate(({ BrowserWindow }, id) => {
    (globalThis as FixtureGlobal).sessionReadFixture.armRead(id);
    BrowserWindow.getAllWindows()[0].webContents.send('chat:changed', id, 'idle');
  }, id);
  await expect.poll(() => app.evaluate(() => (globalThis as FixtureGlobal).sessionReadFixture.readEntered())).toBe(true);
}

/** A later IPC response plus rendering turns drains the released snapshot callback. */
async function settle(page: Page) {
  await page.evaluate(async () => {
    await window.desktop.snapshot();
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

async function beginDeletion(app: ElectronApplication, page: Page) {
  await app.evaluate(() => (globalThis as FixtureGlobal).sessionReadFixture.armDelete());
  const state = (await page.evaluate(() => window.desktop.snapshot())).state;
  const active = state.sessions.find(session => session.id === state.selectedSessionId)!;
  await sessionAction(page, active.title, '删除会话');
  await page.getByRole('dialog', { name: '删除会话', exact: true }).getByRole('button', { name: '确认删除会话', exact: true }).click();
  await expect.poll(() => app.evaluate(() => (globalThis as FixtureGlobal).sessionReadFixture.deleteEntered())).toBe(true);
}

test('snapshot lifecycle: switched-away failures and successful snapshots cannot affect the selected conversation', async () => {
  const f = await workspace();
  try {
    const [a, b] = f.sessions;
    await holdSnapshot(f.app, a.id);
    await f.page.locator('.session-row').filter({ hasText: b.title }).click();
    await expect(f.page.getByRole('heading', { name: b.title, exact: true })).toBeVisible();
    await expect(f.page.locator('.chat-message.user')).toContainText(b.title + '已有记录');
    await f.app.evaluate(() => (globalThis as FixtureGlobal).sessionReadFixture.releaseRead('已经切走的会话读取失败'));
    await settle(f.page);
    await expect(f.page.locator('.error-banner')).toHaveCount(0);

    await holdSnapshot(f.app, b.id);
    await f.page.locator('.session-row').filter({ hasText: a.title }).click();
    await expect(f.page.getByRole('heading', { name: a.title, exact: true })).toBeVisible();
    const stale: ChatSnapshot = { sessionId: b.id, taskState: 'idle', pending: [], messages: [
      { id: 'late', turnId: 'late', role: 'assistant', text: '不应混入当前会话的迟到内容', createdAt: new Date().toISOString() },
    ] };
    await f.app.evaluate((_, value) => (globalThis as FixtureGlobal).sessionReadFixture.releaseRead(undefined, value), stale);
    await settle(f.page);
    await expect(f.page.locator('.chat-message.user')).toContainText(a.title + '已有记录');
    await expect(f.page.getByText('不应混入当前会话的迟到内容', { exact: true })).toHaveCount(0);
    await expect(f.page.locator('.error-banner')).toHaveCount(0);
  } finally { await f.close(); }
});

for (const timing of ['during deletion', 'after deletion'] as const) {
  test(`snapshot lifecycle: a stale failure ${timing} does not report a deleted session error`, async () => {
    const f = await workspace();
    try {
      const [a, b] = f.sessions;
      await holdSnapshot(f.app, a.id);
      await beginDeletion(f.app, f.page);
      if (timing === 'during deletion') {
        await f.app.evaluate(() => (globalThis as FixtureGlobal).sessionReadFixture.releaseRead('会话不存在。'));
        await settle(f.page);
        expect((await f.page.evaluate(() => window.desktop.snapshot())).state.sessions.some(session => session.id === a.id)).toBe(true);
        await expect(f.page.locator('.session-header')).toContainText(a.title);
        await expect(f.page.locator('.error-banner')).toHaveCount(0);
      }
      await f.app.evaluate(() => (globalThis as FixtureGlobal).sessionReadFixture.releaseDelete());
      await expect.poll(async () => (await f.page.evaluate(() => window.desktop.snapshot())).state.sessions.some(session => session.id === a.id)).toBe(false);
      await expect(f.page.getByRole('heading', { name: a.title, exact: true })).toHaveCount(0);
      if (timing === 'after deletion') {
        await f.app.evaluate(() => (globalThis as FixtureGlobal).sessionReadFixture.releaseRead('会话不存在。'));
      }
      await settle(f.page);
      await expect(f.page.locator('.error-banner')).toHaveCount(0);
      expect((await f.page.evaluate(() => window.desktop.snapshot())).state.sessions.map(session => session.id)).toEqual([b.id]);
    } finally { await f.close(); }
  });
}

test('snapshot lifecycle: a pending confirmation cannot clear a session selected through notification navigation', async () => {
  const f = await workspace();
  try {
    const [a, b] = f.sessions;
    await beginDeletion(f.app, f.page);
    await f.page.evaluate(id => window.desktop.setSelection(id), b.id);
    await f.app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send('session:navigate', id), b.id);
    await expect(f.page.locator('.session-header')).toContainText(b.title);
    await expect.poll(async () => (await f.page.evaluate(() => window.desktop.snapshot())).state.selectedSessionId).toBe(b.id);
    await f.app.evaluate(() => (globalThis as FixtureGlobal).sessionReadFixture.releaseDelete());
    await expect.poll(async () => (await f.page.evaluate(() => window.desktop.snapshot())).state.sessions.some(session => session.id === a.id)).toBe(false);
    await settle(f.page);
    await expect(f.page.getByRole('heading', { name: b.title, exact: true })).toBeVisible();
    expect((await f.page.evaluate(() => window.desktop.snapshot())).state.selectedSessionId).toBe(b.id);
    await expect(f.page.getByRole('dialog')).toHaveCount(0);
    await expect(f.page.locator('.error-banner')).toHaveCount(0);
  } finally { await f.close(); }
});

test('snapshot lifecycle: failed deletion resumes reads and current-session failures remain visible', async () => {
  const f = await workspace();
  try {
    const [a] = f.sessions;
    await holdSnapshot(f.app, a.id);
    const before = await f.app.evaluate((_, id) => (globalThis as FixtureGlobal).sessionReadFixture.readCount(id), a.id);
    await beginDeletion(f.app, f.page);
    const deletionDialog = f.page.getByRole('dialog', { name: '删除会话', exact: true });
    await expect(deletionDialog.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
    await expect(deletionDialog.getByRole('button', { name: '正在删除…', exact: true })).toBeDisabled();
    await f.page.keyboard.press('Escape');
    await f.page.locator('.modal-backdrop').click({ position: { x: 2, y: 2 } });
    await expect(deletionDialog).toBeVisible();
    await f.app.evaluate(() => (globalThis as FixtureGlobal).sessionReadFixture.releaseRead('删除开始前发出的旧请求失败'));
    await settle(f.page);
    await expect(f.page.locator('.error-banner')).toHaveCount(0);
    await f.app.evaluate(() => (globalThis as FixtureGlobal).sessionReadFixture.releaseDelete('模拟删除失败，记录仍保留'));
    await expect(deletionDialog.getByRole('alert')).toContainText('模拟删除失败，记录仍保留');
    await deletionDialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(f.page.locator('.error-banner')).toContainText('模拟删除失败，记录仍保留');
    await expect.poll(() => f.app.evaluate((_, id) => (globalThis as FixtureGlobal).sessionReadFixture.readCount(id), a.id)).toBeGreaterThan(before);
    await expect(f.page.getByRole('heading', { name: a.title, exact: true })).toBeVisible();
    await expect(f.page.locator('.chat-message.user')).toContainText(a.title + '已有记录');
    expect((await f.page.evaluate(() => window.desktop.snapshot())).state.sessions).toHaveLength(2);
    await f.page.getByRole('button', { name: '关闭错误', exact: true }).click();
    await holdSnapshot(f.app, a.id);
    await f.app.evaluate(() => (globalThis as FixtureGlobal).sessionReadFixture.releaseRead('当前有效会话的读取确实失败'));
    await expect(f.page.locator('.error-banner')).toContainText('当前有效会话的读取确实失败');
  } finally { await f.close(); }
});
